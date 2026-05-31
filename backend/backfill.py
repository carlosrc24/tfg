"""
backfill.py – One-time historical data ingestion script (2012–2022).

Run this script ONCE to populate the market_intelligence table in Supabase
with 10 years of data so that the LightGBM model has enough rows to train.

Usage (from the backend/ directory, with .env loaded):
    python backfill.py

Or inside the running Docker container:
    docker exec -it tfg_backend python backfill.py

Strategy:
  - Prices:    yfinance (no rate limit on old historical data)
  - News:      Kaggle HuffPost archive (data_YYYY.json in data/kaggle_archive/)
  - Sentiment: FinBERT (same model as the live worker)
  - Indicators: TA-Lib (same pipeline as the live worker)

Performance notes:
  - Daily sentiment is computed ONCE per unique date and reused across all ETFs.
  - A CSV cache (sentiment_cache.csv) is saved so the script can be interrupted
    and resumed without recomputing already-processed days.
  - Supabase inserts are batched in groups of 50 rows to avoid timeouts.
"""
from __future__ import annotations

import logging
import os
import sys
from datetime import date, datetime, timezone
from pathlib import Path

import pandas as pd
from dotenv import load_dotenv
from rich.logging import RichHandler
from rich.progress import Progress, SpinnerColumn, TimeElapsedColumn

# ── Logging ───────────────────────────────────────────────────────────────────
logging.basicConfig(
    level=logging.INFO,
    format="%(message)s",
    datefmt="[%X]",
    handlers=[RichHandler(rich_tracebacks=True)],
)
logger = logging.getLogger("backfill")

# ── Load env before importing project modules ─────────────────────────────────
load_dotenv()

# ── Project imports ───────────────────────────────────────────────────────────
sys.path.insert(0, str(Path(__file__).parent))

import yfinance as yf
from config import ETF_SYMBOLS, SUPABASE_URL, SUPABASE_KEY
from data.news_data import KaggleNewsLoader
from indicators.technical import compute_indicators
from ai.sentiment import aggregate_sentiment
from db.supabase_client import get_client, upsert_etf

# ── Config ────────────────────────────────────────────────────────────────────
BACKFILL_START = "2012-01-01"
BACKFILL_END   = "2022-12-31"
BATCH_SIZE     = 50             # rows per Supabase upsert call

# Cache file to allow resuming interrupted runs
SENTIMENT_CACHE_PATH = Path(__file__).parent / "data" / "kaggle_archive" / "sentiment_cache.csv"

ETF_NAMES: dict[str, str] = {
    "QQQ":  "Invesco QQQ Trust (NASDAQ-100)",
    "SPY":  "SPDR S&P 500 ETF Trust",
    "IWM":  "iShares Russell 2000 ETF",
    "GLD":  "SPDR Gold Shares",
    "XLF":  "Financial Select Sector SPDR Fund",
    "SMH":  "VanEck Semiconductor ETF",
    "XLE":  "Energy Select Sector SPDR Fund",
    "ARKK": "ARK Innovation ETF",
}


# ── Step 1: Pre-compute daily sentiment from Kaggle ───────────────────────────

def build_daily_sentiment_cache() -> dict[date, float]:
    """
    For every unique date in the Kaggle archive, compute the average FinBERT
    sentiment score across all headlines for that day.

    Results are saved to SENTIMENT_CACHE_PATH so the computation is only done
    once even if the script is restarted.
    """
    # Load existing cache if available
    cache: dict[date, float] = {}
    if SENTIMENT_CACHE_PATH.exists():
        df_cache = pd.read_csv(SENTIMENT_CACHE_PATH, parse_dates=["date"])
        cache = dict(zip(df_cache["date"].dt.date, df_cache["sentiment"]))
        logger.info("Loaded %d cached daily sentiment scores.", len(cache))

    df_news = KaggleNewsLoader.load()
    if df_news.empty:
        logger.error(
            "No Kaggle news loaded. Place data_YYYY.json files in "
            "backend/data/kaggle_archive/ and re-run."
        )
        return cache

    # Filter to the backfill date range
    start = pd.to_datetime(BACKFILL_START).date()
    end   = pd.to_datetime(BACKFILL_END).date()
    df_news = df_news[(df_news["date"] >= start) & (df_news["date"] <= end)]

    unique_dates = sorted(df_news["date"].unique())
    dates_to_process = [d for d in unique_dates if d not in cache]
    logger.info(
        "Dates to compute sentiment: %d (skipping %d already cached)",
        len(dates_to_process),
        len(unique_dates) - len(dates_to_process),
    )

    if not dates_to_process:
        return cache

    with Progress(
        SpinnerColumn(),
        "[progress.description]{task.description}",
        TimeElapsedColumn(),
    ) as progress:
        task = progress.add_task("Computing FinBERT sentiment…", total=len(dates_to_process))

        for d in dates_to_process:
            headlines = df_news.loc[df_news["date"] == d, "headline"].tolist()
            score = aggregate_sentiment(headlines) if headlines else 0.0
            cache[d] = round(score, 6)
            progress.advance(task)

            # Persist cache every 50 days so we can resume if interrupted
            if len(cache) % 50 == 0:
                _save_sentiment_cache(cache)

    _save_sentiment_cache(cache)
    logger.info("Sentiment cache complete: %d days", len(cache))
    return cache


def _save_sentiment_cache(cache: dict[date, float]) -> None:
    SENTIMENT_CACHE_PATH.parent.mkdir(parents=True, exist_ok=True)
    df = pd.DataFrame(list(cache.items()), columns=["date", "sentiment"])
    df.to_csv(SENTIMENT_CACHE_PATH, index=False)


# ── Step 2: Download OHLC and insert rows for one ETF ─────────────────────────

def backfill_etf(
    symbol: str,
    etf_id: str,
    sentiment_cache: dict[date, float],
) -> int:
    """
    Download historical OHLC from yfinance, compute indicators, join sentiment,
    and bulk-insert into Supabase market_intelligence.

    Returns the number of rows inserted.
    """
    logger.info("[%s] Downloading OHLC from yfinance (%s → %s)…", symbol, BACKFILL_START, BACKFILL_END)

    df = yf.download(
        symbol,
        start=BACKFILL_START,
        end=BACKFILL_END,
        auto_adjust=True,
        progress=False,
    )

    if df.empty:
        logger.warning("[%s] yfinance returned no data. Skipping.", symbol)
        return 0

    # Flatten MultiIndex columns if present (yfinance ≥ 0.2.x)
    if isinstance(df.columns, pd.MultiIndex):
        df.columns = df.columns.droplevel(1)
    df.columns = [c.lower() for c in df.columns]

    logger.info("[%s] Downloaded %d trading days.", symbol, len(df))

    # Compute technical indicators (requires ≥200 rows for SMA-200)
    if len(df) < 200:
        logger.warning("[%s] Not enough rows (%d) for indicators. Skipping.", symbol, len(df))
        return 0

    df_ind = compute_indicators(df)

    # Build records
    client = get_client()
    inserted = 0
    batch: list[dict] = []

    for ts, row in df_ind.iterrows():
        trading_date = ts.date() if hasattr(ts, "date") else pd.to_datetime(ts).date()
        sentiment = sentiment_cache.get(trading_date, 0.0)

        # Safely extract floats
        def safe(col: str) -> float | None:
            v = row.get(col)
            if v is None or pd.isna(v):
                return None
            return float(v)

        record = {
            "etf_id":          etf_id,
            "timestamp":       ts.isoformat(),
            "close_price":     safe("close"),
            "rsi":             safe("rsi"),
            "adx":             safe("adx"),
            "sma_50":          safe("sma_50"),
            "sma_200":         safe("sma_200"),
            "atr":             safe("atr"),
            "macd_hist":       safe("macd_hist"),
            "bb_width":        safe("bb_width"),
            "bb_pct":          safe("bb_pct"),
            "cdl_doji":        safe("cdl_doji"),
            "cdl_hammer":      safe("cdl_hammer"),
            "cdl_engulfing":   safe("cdl_engulfing"),
            "sentiment_score": sentiment,
            "prediction_prob": None,  # will be updated by the live worker
        }

        # Skip rows with no close price (shouldn't happen, but defensive)
        if record["close_price"] is None:
            continue

        batch.append(record)

        if len(batch) >= BATCH_SIZE:
            _flush_batch(client, batch, symbol)
            inserted += len(batch)
            batch = []

    # Flush remaining
    if batch:
        _flush_batch(client, batch, symbol)
        inserted += len(batch)

    logger.info("[%s] ✓ Inserted %d rows into market_intelligence.", symbol, inserted)
    return inserted


def _flush_batch(client, batch: list[dict], symbol: str) -> None:
    try:
        client.table("market_intelligence").upsert(
            batch, on_conflict="etf_id,timestamp"
        ).execute()
    except Exception as exc:
        logger.error("[%s] Batch insert failed: %s", symbol, exc)


# ── Main ──────────────────────────────────────────────────────────────────────

def main() -> None:
    logger.info("═══ Backfill Script Starting ═══")
    logger.info("Range: %s → %s", BACKFILL_START, BACKFILL_END)
    logger.info("ETFs:  %s", ETF_SYMBOLS)

    # Step 1: Build daily sentiment cache (slow – only done once)
    logger.info("Step 1/2 → Computing daily sentiment from Kaggle archive…")
    sentiment_cache = build_daily_sentiment_cache()

    if not sentiment_cache:
        logger.error(
            "Sentiment cache is empty. Make sure Kaggle JSON files are in "
            "backend/data/kaggle_archive/ and rerun."
        )
        sys.exit(1)

    # Step 2: For each ETF, download and insert
    logger.info("Step 2/2 → Backfilling market_intelligence for each ETF…")
    total = 0
    for symbol in ETF_SYMBOLS:
        etf_name = ETF_NAMES.get(symbol, symbol)
        etf_row = upsert_etf(symbol, etf_name)
        etf_id: str = etf_row["id"]
        rows = backfill_etf(symbol, etf_id, sentiment_cache)
        total += rows

    logger.info("═══ Backfill Complete: %d total rows inserted ═══", total)
    logger.info(
        "You can now restart the worker – LightGBM will train on the historical data."
    )


if __name__ == "__main__":
    main()

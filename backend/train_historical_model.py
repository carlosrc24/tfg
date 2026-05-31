"""
backend/train_historical_model.py

Trains the LightGBM model strictly on data from 2012-01-01 to 2022-12-31.
This ensures ABSOLUTELY ZERO look-ahead bias (Data Leakage) for the 2023-2026 backtest.

v2: Enriches Supabase records with quant features (Beta CAPM, GBM Volatility)
computed from yfinance OHLC.  If yfinance is rate-limited, these features
default to 0.0 (neutral) so training still completes correctly.
"""
from __future__ import annotations

import logging
import time 
from pathlib import Path
import sys

import pandas as pd
import numpy as np

BACKEND_DIR = Path(__file__).resolve().parent

sys.path.insert(0, str(BACKEND_DIR))

from config import ETF_SYMBOLS, MODEL_PATH
from ai.predictor import train

logging.basicConfig(level=logging.INFO, format="%(message)s")
logger = logging.getLogger("train_hist")

STRICT_CUTOFF = "2022-12-31T23:59:59Z"


def _download_ohlc(symbol: str, start: str = "2011-01-01", end: str = "2023-01-01") -> pd.DataFrame | None:
    """"Download OHLC from yfinance. Returns None on failure."""
    try:
        import yfinance as yf
        time.sleep(2)
        df = yf.download(symbol, start=start, end=end, auto_adjust=True, progress=False)
        if df.empty:
            return None
        if isinstance(df.columns, pd.MultiIndex):
            df.columns = df.columns.get_level_values(0)
        df.columns = [c.lower() for c in df.columns]
        if df.index.tz is None:
            df.index = df.index.tz_localize("UTC")
        else:
            df.index = df.index.tz_convert("UTC")
        return df[["open", "high", "low", "close", "volume"]]
        """return df[available]"""
    except Exception as exc:
        logger.warning("Could not download %s from yfinance: %s", symbol, exc)
        return None


def _compute_quant_features(
    records_for_symbol: list[dict],
    df_etf: pd.DataFrame,
    df_spy: pd.DataFrame,
) -> list[dict]:
    """
    Enrich a list of market_intelligence records for a single symbol with:
      - beta_30d, beta_90d  (CAPM rolling beta vs SPY)
      - volatility_30d      (GBM annualised σ)

    All computations use only data up to each record's own timestamp
    (no look-ahead).
    """
    from indicators.technical import compute_beta, compute_gbm_volatility

    # Compute full rolling series on the ETF's own OHLC
    vol_series  = compute_gbm_volatility(df_etf, window=30)
    beta30      = compute_beta(df_etf, df_spy, window=30)
    beta90      = compute_beta(df_etf, df_spy, window=90)

    # Build a lookup dict: date_str -> (vol, b30, b90)
    def _as_date_str(ts) -> str:
        if hasattr(ts, "date"):
            return ts.date().isoformat()
        return str(ts)[:10]

    quant_by_date = {}
    for ts in df_etf.index:
        d = _as_date_str(ts)
        quant_by_date[d] = {
            "volatility_30d": float(vol_series.get(ts, 0.0) or 0.0),
            "beta_30d":       float(beta30.get(ts, 0.0) or 0.0),
            "beta_90d":       float(beta90.get(ts, 0.0) or 0.0),
        }

    enriched = []
    for rec in records_for_symbol:
        ts_str = str(rec.get("timestamp", ""))[:10]
        quant = quant_by_date.get(ts_str, {"volatility_30d": 0.0, "beta_30d": 0.0, "beta_90d": 0.0})
        enriched.append({**rec, **quant})

    return enriched


def _enrich_sentiment_from_kaggle(
    records: list[dict],
    id_to_symbol: dict[str, str],
) -> list[dict]:
    """
    Replace sentiment_score in every record with a value sourced from the
    Kaggle HuffPost archive + FinBERT.  This guarantees the full 2012-2022
    window is covered — Alpaca News only reaches back to ~2015 so records
    from 2012-2014 would otherwise carry sentiment_score = 0.0.

    Kaggle headlines are date-level (not symbol-specific), so FinBERT runs
    once per calendar date and the score is shared across all 8 ETFs for
    that day.  Results are written to the shared backtest_news_cache.json so
    subsequent training runs are instant.
    """
    import json as _json
    from datetime import date as _date
    from ai.sentiment import aggregate_sentiment
    from data.news_data import KaggleNewsLoader

    cache_path = BACKEND_DIR / "data" / "backtest_news_cache.json"
    cache: dict = {}
    if cache_path.exists():
        with open(cache_path, "r", encoding="utf-8") as f:
            cache = _json.load(f)

    date_sentiment: dict[str, float] = {}  # one FinBERT call per calendar date
    updated: list[dict] = []
    cache_dirty = False

    for rec in records:
        sym = id_to_symbol.get(rec.get("etf_id", ""), "UNKNOWN")
        date_str = str(rec.get("timestamp", ""))[:10]
        cache_key = f"{sym}_{date_str}"

        if cache_key in cache:
            score = float(cache[cache_key]["sentiment_score"])
        else:
            if date_str not in date_sentiment:
                try:
                    d = _date.fromisoformat(date_str)
                    headlines = KaggleNewsLoader.get_headlines_for_date(d)
                    date_sentiment[date_str] = aggregate_sentiment(headlines) if headlines else 0.0
                except Exception as exc:
                    logger.warning("Kaggle sentiment error for %s: %s", date_str, exc)
                    date_sentiment[date_str] = 0.0
                if len(date_sentiment) % 100 == 0:
                    logger.info("  Kaggle sentiment: %d unique dates processed so far…", len(date_sentiment))
            score = date_sentiment[date_str]
            cache[cache_key] = {"headlines": [], "sentiment_score": round(score, 6)}
            cache_dirty = True

        updated.append({**rec, "sentiment_score": score})

    if cache_dirty:
        cache_path.parent.mkdir(parents=True, exist_ok=True)
        with open(cache_path, "w", encoding="utf-8") as f:
            _json.dump(cache, f, ensure_ascii=False, indent=2)
        logger.info("Cache saved: %d total entries.", len(cache))

    logger.info(
        "Kaggle sentiment enrichment done — %d unique dates scored, %d records updated.",
        len(date_sentiment), len(updated),
    )
    return updated


def train_historical():
    logger.info("══════════════════════════════════════════════════════")
    logger.info("  TRAINING HISTORICAL MODEL (100% OUT-OF-SAMPLE SAFE) ")
    logger.info("  Period: 2012-01-01 to 2022-12-31")
    logger.info("  OHLC:    yfinance  |  News: Kaggle HuffPost archive")
    logger.info("  Features: TA-Lib + Sentiment EMA-5 + Beta + GBM Vol")
    logger.info("══════════════════════════════════════════════════════")

    from db.supabase_client import get_client
    client = get_client()

    # ── 1. Fetch all historical rows from Supabase ─────────────────────────────
    limit = 1000
    offset = 0
    all_records: list[dict] = []

    while True:
        resp = (
            client.table("market_intelligence")
            .select("*")
            .lte("timestamp", STRICT_CUTOFF)
            .range(offset, offset + limit - 1)
            .execute()
        )
        data = resp.data
        if not data:
            break
        all_records.extend(data)
        logger.info("Fetched %d historical rows from Supabase...", len(all_records))
        if len(data) < limit:
            break
        offset += limit

    if not all_records:
        logger.error("No historical data found in Supabase! Make sure backfill.py ran successfully.")
        return

    logger.info("Total historical rows fetched: %d", len(all_records))

    # ── 2. Fetch ETF ids to map etf_id → symbol ───────────────────────────────
    etf_resp = client.table("etfs").select("id,symbol").execute()
    id_to_symbol = {row["id"]: row["symbol"] for row in etf_resp.data}

    # ── 3. Re-score sentiment from Kaggle (replaces Alpaca-sourced scores) ───────
    # Supabase records may carry sentiment_score = 0.0 for pre-2015 dates because
    # Alpaca News has no coverage before ~2015.  Re-scoring from the Kaggle archive
    # ensures uniform, accurate sentiment across the full 2012-2022 window.
    # Must happen BEFORE grouping by symbol so every per-symbol record list carries
    # the updated sentiment_score when quant features are computed in step 5.
    logger.info("Re-scoring sentiment from Kaggle HuffPost archive (2012-2022)…")
    all_records = _enrich_sentiment_from_kaggle(all_records, id_to_symbol)

    # Group by symbol using the sentiment-enriched records
    by_symbol: dict[str, list[dict]] = {}
    for rec in all_records:
        sym = id_to_symbol.get(rec.get("etf_id", ""), "UNKNOWN")
        by_symbol.setdefault(sym, []).append(rec)

    # ── 4. Download SPY for Beta computation (yfinance) ───────────────────────
    logger.info("Downloading SPY reference for Beta computation (yfinance)…")
    df_spy = _download_ohlc("SPY")

    # ── 5. Enrich records with quant features per symbol (yfinance OHLC) ─────
    enriched_all: list[dict] = []
    for sym, recs in by_symbol.items():
        if sym == "UNKNOWN":
            enriched_all.extend(recs)
            continue

        logger.info("Computing quant features for %s (%d records)...", sym, len(recs))
        df_etf = _download_ohlc(sym)

        if df_etf is not None and df_spy is not None:
            try:
                enriched = _compute_quant_features(recs, df_etf, df_spy)
                enriched_all.extend(enriched)
                logger.info("  → Beta/Vol features added for %s.", sym)
            except Exception as exc:
                logger.warning("  → Failed quant enrichment for %s: %s. Using neutrals.", sym, exc)
                for r in recs:
                    enriched_all.append({**r, "beta_30d": 0.0, "beta_90d": 0.0, "volatility_30d": 0.0})
        else:
            logger.warning("  → No OHLC for %s — quant features set to 0.0.", sym)
            for r in recs:
                enriched_all.append({**r, "beta_30d": 0.0, "beta_90d": 0.0, "volatility_30d": 0.0})

    logger.info("Total enriched records ready for training: %d", len(enriched_all))

    # ── 6. Train and persist the model ────────────────────────────────────────
    logger.info("Training LightGBM model strictly on 2012-2022 data...")
    train(enriched_all)

    logger.info("✅ STRICT Historical Model (v2) saved to %s", MODEL_PATH)
    logger.info("You can now run reset_backtest.py and backtest_engine.py safely.")


if __name__ == "__main__":
    train_historical()

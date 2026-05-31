"""
worker.py – Main orchestrator for the ETF Algorithmic Trading System.

Pipeline (runs every WORKER_INTERVAL_MINUTES):
  1. For each ETF in ETF_SYMBOLS:
     a. Fetch OHLC data              → data/market_data.py
     b. Compute TA-Lib indicators    → indicators/technical.py
     c. Fetch news headlines         → data/news_data.py
     d. Score sentiment with FinBERT → ai/sentiment.py
     e. Persist to Supabase          → db/supabase_client.py
     f. Load / train LightGBM        → ai/predictor.py
     g. Predict probability of rise  → ai/predictor.py
     h. Execute trade signal         → execution/alpaca_trader.py
     i. Update prediction_prob in DB → db/supabase_client.py
"""

from __future__ import annotations

import logging
import sys
import time
from datetime import datetime, timezone

import schedule
from rich.logging import RichHandler

# ── Logging setup ─────────────────────────────────────────────────────────────
logging.basicConfig(
    level=logging.INFO,
    format="%(message)s",
    datefmt="[%X]",
    handlers=[RichHandler(rich_tracebacks=True)],
)
logger = logging.getLogger("worker")

# ── Internal imports (after logging is configured) ────────────────────────────
from config import ETF_SYMBOLS, WORKER_INTERVAL_MINUTES
from data.market_data import fetch_ohlc_alpaca
from data.news_data import fetch_headlines
from indicators.technical import compute_indicators, get_latest_indicators
from ai.sentiment import aggregate_sentiment
from ai import predictor
from db.supabase_client import (
    upsert_etf,
    get_etf_id,
    upsert_market_intelligence,
    fetch_recent_intelligence,
    upsert_equity_snapshot,
)
from execution.alpaca_trader import execute_signal, get_account

# ETF display names
ETF_NAMES: dict[str, str] = {
    "QQQ": "Invesco QQQ Trust (NASDAQ-100)",
    "SPY": "SPDR S&P 500 ETF Trust",
    "IWM": "iShares Russell 2000 ETF",
    "GLD": "SPDR Gold Shares",
    "XLF": "Financial Select Sector SPDR Fund",
    "SMH": "VanEck Semiconductor ETF",
    "XLE": "Energy Select Sector SPDR Fund",
    "ARKK": "ARK Innovation ETF"
}


# ── Core pipeline ──────────────────────────────────────────────────────────────

def process_etf(symbol: str) -> None:
    """Run the full pipeline for a single ETF symbol."""
    logger.info("═══ Processing %s ═══", symbol)

    # 1. Ensure ETF exists in DB
    etf_name = ETF_NAMES.get(symbol, symbol)
    etf_row = upsert_etf(symbol, etf_name)
    etf_id: str = etf_row["id"]
    logger.info("%s → etf_id=%s", symbol, etf_id)

    # 2. Fetch OHLC
    logger.info("[%s] Fetching OHLC data …", symbol)
    df = fetch_ohlc_alpaca(symbol)

    # 3. Compute TA-Lib indicators
    logger.info("[%s] Computing technical indicators …", symbol)
    df_indicators = compute_indicators(df)
    latest_indicators = get_latest_indicators(df)

    # 4. Fetch news & compute sentiment
    logger.info("[%s] Fetching news headlines …", symbol)
    headlines = fetch_headlines(symbol, hours_back=24)
    logger.info("[%s] Scoring sentiment with FinBERT (%d headlines) …", symbol, len(headlines))
    sentiment_score = aggregate_sentiment(headlines)
    logger.info("[%s] Sentiment score: %.4f", symbol, sentiment_score)

    # 5. Build the market_intelligence record (no prediction yet)
    timestamp = df_indicators.index[-1].isoformat()
    record: dict = {
        "etf_id":          etf_id,
        "timestamp":       timestamp,
        "close_price":     latest_indicators["close_price"],
        "rsi":             latest_indicators["rsi"],
        "adx":             latest_indicators["adx"],
        "sma_50":          latest_indicators["sma_50"],
        "sma_200":         latest_indicators["sma_200"],
        "atr":             latest_indicators["atr"],
        "macd_hist":       latest_indicators["macd_hist"],
        "bb_width":        latest_indicators["bb_width"],
        "bb_pct":          latest_indicators["bb_pct"],
        "cdl_doji":        latest_indicators["cdl_doji"],
        "cdl_hammer":      latest_indicators["cdl_hammer"],
        "cdl_engulfing":   latest_indicators["cdl_engulfing"],
        "sentiment_score": round(sentiment_score, 6),
        "prediction_prob": None,  # will be filled after model inference
    }

    # 6. Load / train LightGBM
    logger.info("[%s] Loading AI model …", symbol)
    historical_records = fetch_recent_intelligence(etf_id, limit=500)
    model = predictor.load_or_train(historical_records)

    # 7. Predict
    features = {**latest_indicators, "sentiment_score": sentiment_score}
    prediction_prob = predictor.predict_proba(features)
    logger.info("[%s] Prediction probability (↑): %.4f", symbol, prediction_prob)
    record["prediction_prob"] = round(prediction_prob, 6)

    # 8. Persist to Supabase
    logger.info("[%s] Persisting to Supabase …", symbol)
    saved_row = upsert_market_intelligence(record)
    logger.info("[%s] Saved row id=%s", symbol, saved_row.get("id"))

    # 9. Execute trade signal via Alpaca Paper Trading
    logger.info("[%s] Evaluating trade signal …", symbol)
    current_price = float(latest_indicators["close_price"])
    action = execute_signal(
        symbol=symbol,
        etf_id=etf_id,
        prediction_prob=prediction_prob,
        current_price=current_price,
    )
    logger.info("[%s] Action taken: %s", symbol, action)


def save_equity_snapshot() -> None:
    """Record today's Alpaca portfolio value + SPY close price in equity_history."""
    try:
        account = get_account()
        total_value = float(account.portfolio_value)

        # SPY benchmark: pull latest close from market_intelligence
        from db.supabase_client import get_client
        client = get_client()
        spy_row = (
            client.table("etfs")
            .select("id")
            .eq("symbol", "SPY")
            .maybe_single()
            .execute()
        )
        benchmark_value: float | None = None
        if spy_row.data:
            spy_intel = (
                client.table("market_intelligence")
                .select("close_price")
                .eq("etf_id", spy_row.data["id"])
                .order("timestamp", desc=True)
                .limit(1)
                .maybe_single()
                .execute()
            )
            if spy_intel.data:
                benchmark_value = float(spy_intel.data["close_price"])

        upsert_equity_snapshot(total_value, benchmark_value)
    except Exception as exc:
        logger.warning("Could not save equity snapshot: %s", exc)


def run_pipeline() -> None:
    """Process all ETFs in ETF_SYMBOLS."""
    start = datetime.now(tz=timezone.utc)
    logger.info("━━━ Pipeline run started at %s ━━━", start.isoformat())

    for symbol in ETF_SYMBOLS:
        try:
            process_etf(symbol)
        except Exception as exc:
            logger.exception("Error processing %s: %s", symbol, exc)

    # Save daily equity snapshot after all ETFs are processed
    save_equity_snapshot()

    elapsed = (datetime.now(tz=timezone.utc) - start).total_seconds()
    logger.info("━━━ Pipeline run finished in %.1fs ━━━", elapsed)


# ── Scheduler ──────────────────────────────────────────────────────────────────

def main() -> None:
    logger.info("ETF Trading Worker starting up …")
    logger.info("ETFs tracked: %s", ETF_SYMBOLS)
    logger.info("Interval: every %d minutes", WORKER_INTERVAL_MINUTES)

    logger.info("Worker loop running. Press Ctrl+C to stop.")
    try:
        while True:
            # ── PAUSADO PARA BACKTESTING ──
            # Para evitar que el Live Worker ensucie la base de datos 
            # o re-entrene el modelo con datos del futuro (2023-2026),
            # hemos comentado run_pipeline().
            #
            # run_pipeline()
            
            logger.info("Worker loop is PAUSED for Backtesting. Waiting...")
            time.sleep(WORKER_INTERVAL_MINUTES * 60)
            
    except KeyboardInterrupt:
        logger.info("Worker stopped by user.")
        sys.exit(0)


if __name__ == "__main__":
    main()

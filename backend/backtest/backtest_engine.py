"""
backtest/backtest_engine.py – Out-of-sample backtest motor (2023-01-01 → hoy).

Protocol:
  - Model:    Loads the pre-trained LightGBM model from MODEL_PATH.
              Does NOT retrain during the simulation (true out-of-sample).
  - Prices:   Alpaca historical bars API (authenticated, bulk fetch).
  - News:     Alpaca News API for dates >= 2023-01-01.
              KaggleNewsLoader for dates <= 2022-12-31 (residual support).
  - Cache:    backend/data/backtest_news_cache.json stores {headlines, sentiment}
              per (symbol, date) to avoid redundant API calls and FinBERT passes.

Anti-leakage rules:
  1. Features on Day N use OHLC data up to and INCLUDING Day N only.
  2. Beta and Volatility computed from the same sliced df_slice → no leakage.
  3. Sentiment EMA is maintained as a running state variable per ETF.
  4. Trade executed at Open price of Day N+1 (next-day open).

Quant improvements (v2):
  - Beta Dinámica (CAPM) 30d / 90d vs SPY
  - GBM Volatility 30d (annualised)
  - Sentiment EMA-5 (rolling, no future data)
  - Death Cross Trend Filter: BUY signals suppressed if SMA-50 < SMA-200
  - Hysteresis ±5%: HOLD if |prob - last_prob| < 0.05
  - Dynamic Stop-Loss: ATR × max(1.5, volatility × 2) per position

- Storage:  All trades and equity snapshots saved to Supabase with
              is_backtest = TRUE so they never mix with live data.

Usage (run from backend/ directory or inside the Docker container):
    python -m backtest.backtest_engine
    python -m backtest.backtest_engine --start 2023-06-01 --capital 50000
"""
from __future__ import annotations

import argparse
import json
import logging
import os
import sys
from collections import defaultdict
from datetime import datetime, date, timedelta, timezone
from pathlib import Path

import joblib
import pandas as pd
from alpaca.data.historical import StockHistoricalDataClient
from alpaca.data.historical.news import NewsClient
from alpaca.data.requests import StockBarsRequest, NewsRequest
from alpaca.data.timeframe import TimeFrame
from rich.logging import RichHandler
from rich.progress import Progress, SpinnerColumn, TextColumn, BarColumn, TimeRemainingColumn

# ── Logging ───────────────────────────────────────────────────────────────────
logging.basicConfig(
    level=logging.INFO,
    format="%(message)s",
    datefmt="[%X]",
    handlers=[RichHandler(rich_tracebacks=True)],
)
logger = logging.getLogger("backtest")

# ── Path bootstrap ─────────────────────────────────────────────────────────────
BACKEND_DIR = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(BACKEND_DIR))

from config import (
    ALPACA_API_KEY, ALPACA_SECRET_KEY,
    ETF_SYMBOLS, MODEL_PATH,
)
from indicators.technical import (
    compute_indicators, get_latest_indicators,
    compute_beta, compute_gbm_volatility,
)
from ai.sentiment import aggregate_sentiment
from ai.predictor import predict_proba_filtered
from data.news_data import KaggleNewsLoader
from db.supabase_client import get_client, upsert_etf
from backtest.virtual_wallet import VirtualWallet

# ── Constants ─────────────────────────────────────────────────────────────────
CACHE_PATH = BACKEND_DIR / "data" / "backtest_news_cache.json"
BACKTEST_START_DEFAULT = date(2023, 1, 1)
WARMUP_DAYS = 400          # extra lookback so SMA-200 is valid from day 1
HYSTERESIS_THRESHOLD = 0.05  # minimum prob Δ to suppress a repeat signal

# ── Alpaca News client ────────────────────────────────────────────────────────
_news_client: NewsClient | None = None


def _get_news_client() -> NewsClient:
    global _news_client
    if _news_client is None:
        _news_client = NewsClient(
            api_key=ALPACA_API_KEY,
            secret_key=ALPACA_SECRET_KEY,
        )
    return _news_client


# ── News + Sentiment cache ─────────────────────────────────────────────────────

def _load_cache() -> dict:
    if CACHE_PATH.exists():
        with open(CACHE_PATH, "r", encoding="utf-8") as f:
            return json.load(f)
    return {}


def _save_cache(cache: dict) -> None:
    CACHE_PATH.parent.mkdir(parents=True, exist_ok=True)
    with open(CACHE_PATH, "w", encoding="utf-8") as f:
        json.dump(cache, f, ensure_ascii=False, indent=2)


def fetch_news_cached(
    symbol: str,
    day: date,
    cache: dict,
) -> tuple[list[str], float]:
    """
    Fetch headlines + sentiment for (symbol, day).
    Returns (headlines, sentiment_score).
    Results are cached to avoid redundant API calls and FinBERT passes.
    """
    cache_key = f"{symbol}_{day.isoformat()}"

    if cache_key in cache:
        entry = cache[cache_key]
        return entry["headlines"], entry["sentiment_score"]

    headlines: list[str] = []

    if day <= date(2022, 12, 31):
        headlines = KaggleNewsLoader.get_headlines_for_date(day)
        logger.debug("[%s] Kaggle news for %s: %d headlines", symbol, day, len(headlines))
    else:
        try:
            client = _get_news_client()
            start_dt = datetime.combine(day, datetime.min.time()).replace(tzinfo=timezone.utc)
            end_dt   = start_dt + timedelta(days=1)
            req = NewsRequest(symbols=symbol, start=start_dt, end=end_dt, limit=50)
            news_set = client.get_news(req)
            headlines = [a.headline for a in news_set.news]
        except Exception as exc:
            logger.warning("[%s] News API error for %s: %s — using neutral sentiment.", symbol, day, exc)

    sentiment_score = aggregate_sentiment(headlines) if headlines else 0.0

    cache[cache_key] = {
        "headlines": headlines,
        "sentiment_score": round(sentiment_score, 6),
    }
    return headlines, sentiment_score


# ── Supabase persistence ───────────────────────────────────────────────────────

def save_bt_trade(
    etf_id: str,
    trade_record,
    timestamp: str,
    run_id: str | None = None,
) -> None:
    client = get_client()
    record = {
        "etf_id":      etf_id,
        "action":      trade_record.action,
        "price":       round(trade_record.price, 4),
        "quantity":    round(trade_record.quantity, 4),
        "profit_loss": round(trade_record.profit_loss, 4) if trade_record.profit_loss is not None else None,
        "is_backtest": True,
        "timestamp":   timestamp,
    }
    if run_id is not None:
        record["run_id"] = run_id
    client.table("trades").insert(record).execute()


def save_bt_equity(
    timestamp: str,
    total_value: float,
    benchmark_value: float | None,
    run_id: str | None = None,
) -> None:
    client = get_client()
    # Delete any existing row for this (timestamp, is_backtest, run_id) combination
    delete_q = (
        client.table("equity_history")
        .delete()
        .eq("timestamp", timestamp)
        .eq("is_backtest", True)
    )
    if run_id is not None:
        delete_q = delete_q.eq("run_id", run_id)
    delete_q.execute()

    row: dict = {
        "timestamp":       timestamp,
        "total_value":     round(total_value, 2),
        "benchmark_value": round(benchmark_value, 2) if benchmark_value is not None else None,
        "is_backtest":     True,
    }
    if run_id is not None:
        row["run_id"] = run_id
    client.table("equity_history").insert(row).execute()


# ── Main simulation ────────────────────────────────────────────────────────────

def run_backtest(
    start: date = BACKTEST_START_DEFAULT,
    end: date | None = None,
    initial_capital: float = 100_000.0,
    atr_multiplier: float = 2.5,
    trend_sma: int = 50,
    min_holding_days: int = 3,
    confirmation_days: int = 2,
    alpha_factor: float = 1.0,
    beta_factor: float = 1.0,
    max_allocation_pct: float = 0.20,
    take_profit_pct: float = 0.0,
    sentiment_weight: float = 0.0,
    run_id: str | None = None,
    show_progress: bool = True,
    log_flush_fn=None,
) -> None:
    end = end or date.today()

    # Alpaca's free tier returns 403 when StockBarsRequest.end touches today
    # (SIP real-time data gate). Always cap to yesterday.
    end = min(end, date.today() - timedelta(days=1))

    # Compute effective buy threshold from alpha_factor: 0.60 / alpha_factor
    # clamped to [0.35, 0.90] so it stays meaningful
    effective_buy_threshold = round(min(max(0.60 / alpha_factor, 0.35), 0.90), 4)

    logger.info("═══════════════════════════════════════════")
    logger.info("  BACKTEST ENGINE  %s → %s", start, end)
    logger.info("  Initial capital : $%s", format(initial_capital, ",.2f"))
    logger.info("  ATR multiplier  : %.1f", atr_multiplier)
    logger.info("  Trend SMA       : %d", trend_sma)
    logger.info("  Min holding days: %d", min_holding_days)
    logger.info("  Confirm days    : %d", confirmation_days)
    logger.info("  Alpha factor    : %.2f → buy threshold %.2f", alpha_factor, effective_buy_threshold)
    logger.info("  Beta factor     : %.2f", beta_factor)
    logger.info("  Max allocation  : %.0f%%", max_allocation_pct * 100)
    logger.info("  Take profit     : %.0f%%", take_profit_pct * 100)
    logger.info("  Sentiment weight: %.2f (ω)", sentiment_weight)
    logger.info("  Run ID          : %s", run_id or "CLI")
    logger.info("  Quant features  : Beta CAPM · GBM Vol · Sentiment EMA-5")
    logger.info("  Filters         : SMA-%d macro · Hysteresis ±5%% (uniform, no bypass)", trend_sma)
    logger.info("═══════════════════════════════════════════")

    # ── 1. Load pre-trained model ──────────────────────────────────────────────
    model_path = Path(MODEL_PATH)
    if not model_path.exists():
        alt_path = BACKEND_DIR / "models" / "lgbm_model.pkl"
        if alt_path.exists():
            model_path = alt_path
        else:
            logger.error(
                "No trained model found at %s.\n"
                "Run train_historical_model.py first.",
                MODEL_PATH,
            )
            sys.exit(1)

    joblib.load(model_path)  # pre-load to warm up the global _model singleton
    # Use module-level singleton so predict_proba_filtered works
    import ai.predictor as _pred
    _pred._model = joblib.load(model_path)
    logger.info("Model loaded from %s", model_path)

    # ── 2. Download full OHLC history for all symbols via Alpaca ─────────────
    download_start = start - timedelta(days=WARMUP_DAYS)
    logger.info("Downloading OHLC data from %s to %s via Alpaca …", download_start, end)

    stock_client = StockHistoricalDataClient(
        api_key=ALPACA_API_KEY,
        secret_key=ALPACA_SECRET_KEY,
    )
    bars_request = StockBarsRequest(
        symbol_or_symbols=ETF_SYMBOLS,
        timeframe=TimeFrame.Day,
        start=datetime.combine(download_start, datetime.min.time()).replace(tzinfo=timezone.utc),
        end=datetime.combine(end + timedelta(days=1), datetime.min.time()).replace(tzinfo=timezone.utc),
        adjustment="all",
    )
    logger.info("Fetching bars from Alpaca (single bulk request for all symbols)…")
    bars_response = stock_client.get_stock_bars(bars_request)
    bars_df = bars_response.df  # MultiIndex (symbol, timestamp)

    all_ohlc: dict[str, pd.DataFrame] = {}
    for sym in ETF_SYMBOLS:
        try:
            df = bars_df.loc[sym].copy()
            if df.index.tz is None:
                df.index = df.index.tz_localize("UTC")
            else:
                df.index = df.index.tz_convert("UTC")
            available = [c for c in ["open", "high", "low", "close", "volume"] if c in df.columns]
            all_ohlc[sym] = df[available]
            logger.info("  %s: %d bars", sym, len(df))
        except KeyError:
            logger.warning("  %s: no data returned from Alpaca — symbol will be skipped.", sym)
            all_ohlc[sym] = pd.DataFrame(columns=["open", "high", "low", "close", "volume"])

    # SPY is our benchmark — always present
    df_spy_full = all_ohlc["SPY"]

    # ── 3. Build list of trading days ─────────────────────────────────────────
    spy_full = all_ohlc["SPY"]
    trading_days = spy_full.index[
        (spy_full.index.date >= start) & (spy_full.index.date < end)
    ]
    trading_days = trading_days[:-1]  # need D+1 open for execution
    logger.info("Simulating %d trading days.", len(trading_days))

    # ── 4. Resolve ETF ids in Supabase ────────────────────────────────────────
    etf_names: dict[str, str] = {
        "QQQ": "Invesco QQQ Trust", "SPY": "SPDR S&P 500 ETF",
        "IWM": "iShares Russell 2000", "GLD": "SPDR Gold Shares",
        "XLF": "Financial Select Sector", "SMH": "VanEck Semiconductor ETF",
        "XLE": "Energy Select Sector", "ARKK": "ARK Innovation ETF",
    }
    etf_ids: dict[str, str] = {}
    for sym in ETF_SYMBOLS:
        row = upsert_etf(sym, etf_names.get(sym, sym))
        etf_ids[sym] = row["id"]

    # ── 5. Load news/sentiment cache ──────────────────────────────────────────
    cache = _load_cache()
    logger.info("News cache loaded: %d entries.", len(cache))

    # ── 6. Initialize virtual wallet ──────────────────────────────────────────
    wallet = VirtualWallet(
        initial_balance=initial_capital,
        atr_multiplier=atr_multiplier,
        beta_factor=beta_factor,
        min_holding_days=min_holding_days,
        buy_threshold=effective_buy_threshold,
        max_allocation_pct=max_allocation_pct,
        take_profit_pct=take_profit_pct,
    )

    # ── 7. Quant state: sentiment EMA and last-prob per symbol ────────────────
    _ema_alpha = 2 / (5 + 1)
    sentiment_ema: dict[str, float] = defaultdict(float)
    last_prob:     dict[str, float] = {}                # hysteresis: last seen prob
    prob_history:  dict[str, list[float]] = {}          # signal confirmation window

    # ── 8. Feature column list (must match predictor.FEATURE_COLS) ────────────
    FEATURE_COLS = [
        "rsi", "adx", "sma_50", "sma_100", "sma_200", "atr",
        "macd_hist", "bb_width", "bb_pct",
        "cdl_doji", "cdl_hammer", "cdl_engulfing",
        "sentiment_score", "sentiment_ema_5d",
        "beta_30d", "beta_90d", "volatility_30d",
    ]

    # ── 9. Day-by-day simulation ──────────────────────────────────────────────
    total_days = len(trading_days)
    _last_pct_reported = 0
    current_prices: dict[str, float] = {}
    _signal_stats: dict[str, int] = {"passed": 0, "total": 0}

    def _advance_progress(idx: int) -> None:
        nonlocal _last_pct_reported
        # Flush accumulated log lines to DB on every call (called every 5 days).
        # This ensures terminal_logs streams live rather than batching for 2+ s.
        if log_flush_fn is not None:
            try:
                log_flush_fn()
            except Exception:
                pass
        if run_id is None:
            return
        pct = int((idx + 1) / total_days * 100)
        if pct >= _last_pct_reported + 5:
            try:
                get_client().table("backtest_runs").update(
                    {"progress_pct": pct}
                ).eq("id", run_id).execute()
            except Exception:
                pass
            _last_pct_reported = pct

    def _get_trend_sma_value(indicators: dict, df_slice) -> float | None:
        """Return the SMA value for the chosen trend_sma period."""
        if trend_sma == 20:
            if len(df_slice) >= 20:
                return float(df_slice["close"].rolling(20).mean().iloc[-1])
            return None
        return indicators.get(f"sma_{trend_sma}")

    def _run_loop(progress_ctx=None, task_id=None) -> None:
        nonlocal current_prices
        for idx, ts_day in enumerate(trading_days):
            day = ts_day.date()

            # Current-day prices (for portfolio valuation)
            current_prices.clear()
            for sym in ETF_SYMBOLS:
                df = all_ohlc[sym]
                row = df[df.index == ts_day]
                if not row.empty:
                    current_prices[sym] = float(row["close"].iloc[0])

            spy_close = current_prices.get("SPY")
            _day_probs: list[float] = []

            # ── Per-ETF processing ────────────────────────────────────────────

            for sym in ETF_SYMBOLS:
                df_full = all_ohlc[sym]

                # Anti-leakage slice: only data up to Day N (inclusive)
                df_slice = df_full[df_full.index <= ts_day]
                if len(df_slice) < 210:
                    continue  # not enough warmup for SMA-200

                # Next-day open = execution price
                future_rows = df_full[df_full.index > ts_day]
                if future_rows.empty:
                    continue  # not enough warmup for SMA-200
                exec_price = float(future_rows["open"].iloc[0])
                if exec_price <= 0:
                    continue  # not enough warmup for SMA-200

                # SPY slice for Beta (also up to Day N only — no leakage)
                spy_slice = df_spy_full[df_spy_full.index <= ts_day]

                # Technical indicators + quant features
                try:
                    indicators = get_latest_indicators(df_slice, df_spy=spy_slice)
                except Exception as exc:
                    logger.debug("[%s] Indicator error on %s: %s", sym, day, exc)
                    continue  # not enough warmup for SMA-200

                # News + raw sentiment (cached)
                _, raw_sentiment = fetch_news_cached(sym, day, cache)

                # Sentiment EMA-5 (running state, no future data)
                if sym not in sentiment_ema:
                    sentiment_ema[sym] = raw_sentiment
                else:
                    sentiment_ema[sym] = (
                        _ema_alpha * raw_sentiment
                        + (1 - _ema_alpha) * sentiment_ema[sym]
                    )

                # Build feature dict for the model
                features = {
                    **indicators,
                    "sentiment_score":  raw_sentiment,
                    "sentiment_ema_5d": sentiment_ema[sym],
                }

                # Model prediction + Price>SMA-100 trend filter
                prediction_prob, trend_bullish = predict_proba_filtered(features)

                # Multimodal fusion: blend LightGBM prob with FinBERT sentiment EMA
                if sentiment_weight > 0.0:
                    norm_sentiment = (sentiment_ema[sym] + 1.0) / 2.0
                    prediction_prob = round(
                        (1.0 - sentiment_weight) * prediction_prob
                        + sentiment_weight * norm_sentiment,
                        4,
                    )

                _day_probs.append(round(prediction_prob, 3))
                _signal_stats["total"] += 1
                if prediction_prob >= effective_buy_threshold:
                    _signal_stats["passed"] += 1

                atr        = indicators.get("atr") or 0.0
                volatility = indicators.get("volatility_30d") or 0.20
                beta_val   = indicators.get("beta_30d") or 1.0
                today_close = current_prices.get(sym)

                # ── STEP A: Advance trailing high/low water marks ─────────────
                if today_close is not None:
                    wallet.update_highest_price(sym, today_close)
                    wallet.update_lowest_price(sym, today_close)

                # ── STEP B: Trailing stop evaluation (tiered) ─────────────────
                exec_ts = future_rows.index[0].isoformat()
                if today_close is not None and atr > 0:
                    stop_trades = wallet.check_trailing_stop(
                        symbol=sym,
                        close_price=today_close,
                        execution_price=exec_price,
                        atr=atr,
                        volatility=volatility,
                        current_date=day,
                    )
                    for tr in stop_trades:
                        save_bt_trade(etf_ids[sym], tr, exec_ts, run_id)
                        logger.info(
                            "[STOP-LOSS] %s — %s %.4f shares @ $%.2f | P&L: %s",
                            sym, tr.action, tr.quantity, tr.price,
                            f"${tr.profit_loss:+.2f}" if tr.profit_loss is not None else "n/a",
                        )

                # ── STEP C: Hysteresis & Signal Confirmation ──────────────────
                if sym not in prob_history:
                    prob_history[sym] = []
                prob_history[sym].append(prediction_prob)
                if len(prob_history[sym]) > confirmation_days:
                    prob_history[sym].pop(0)

                # Signal confirmation: BUY requires confirmation_days consecutive
                # days above threshold — no bypass regardless of cash state.
                confirmed_prob = prediction_prob
                if prediction_prob >= effective_buy_threshold:
                    if len(prob_history[sym]) < confirmation_days or any(
                        p < effective_buy_threshold for p in prob_history[sym]
                    ):
                        confirmed_prob = effective_buy_threshold - 0.01

                # Hysteresis: skip if prob change is below the dead-zone threshold.
                # Applied uniformly — no special case for fully-cash state.
                if sym in last_prob:
                    if abs(prediction_prob - last_prob[sym]) < HYSTERESIS_THRESHOLD:
                        continue
                last_prob[sym] = prediction_prob

                # ── STEP D: Execute trade signal ──────────────────────────────
                # Dynamic macro-regime filter using the user-selected trend SMA
                trend_sma_val = _get_trend_sma_value(indicators, df_slice)
                macro_uptrend = (
                    today_close is not None
                    and trend_sma_val is not None
                    and today_close > trend_sma_val
                )

                try:
                    trades = wallet.execute_signal(
                        symbol=sym,
                        prediction_prob=confirmed_prob,
                        execution_price=exec_price,
                        current_date=day,
                        trend_bullish=trend_bullish,
                        macro_uptrend=macro_uptrend,
                        atr=atr,
                        volatility=volatility,
                        current_price=today_close,
                        close_price=today_close,
                        beta=float(beta_val),
                    )
                except Exception as exc:
                    logger.warning("[%s] Trade error on %s: %s", sym, day, exc)
                    trades = []

                for tr in trades:
                    save_bt_trade(etf_ids[sym], tr, exec_ts, run_id)
                    action_label = {
                        "BUY":  "LONG",
                        "SELL": "EXIT",
                    }.get(tr.action, tr.action)
                    pl_str = (
                        f" | P&L: ${tr.profit_loss:+.2f}" if tr.profit_loss is not None else ""
                    )
                    logger.info(
                        "[TRADE] [%s] %s %.4f shares of %s @ $%.2f%s",
                        action_label, tr.action, tr.quantity, sym, tr.price, pl_str,
                    )

            # Log raw prediction stats to understand model lockout
            if idx % 30 == 0:
                print(
                    f"[DIAGNOSTIC] Date: {ts_day.strftime('%Y-%m-%d')} | "
                    f"Sample LightGBM Probabilities: {_day_probs}",
                    flush=True,
                )

            # Daily equity snapshot
            port_value = wallet.portfolio_value(current_prices)
            save_bt_equity(ts_day.isoformat(), port_value, spy_close, run_id)

            # Progress heartbeat every 30 simulated days
            if idx % 30 == 0 or idx == total_days - 1:
                logger.info(
                    "[INFO] Simulating Day %d/%d (%s) | Portfolio: $%s | Cash: $%s",
                    idx + 1, total_days, day,
                    format(port_value, ",.2f"),
                    format(wallet.balance, ",.2f"),
                )

            if idx % 5 == 0 or idx == total_days - 1:
                _advance_progress(idx)
            if progress_ctx is not None and task_id is not None:
                progress_ctx.advance(task_id)
            if idx % 20 == 0:
                _save_cache(cache)

    if show_progress:
        with Progress(
            SpinnerColumn(),
            TextColumn("[bold cyan]Day {task.completed}/{task.total}"),
            BarColumn(),
            TimeRemainingColumn(),
        ) as progress:
            task = progress.add_task("Simulating…", total=total_days)
            _run_loop(progress_ctx=progress, task_id=task)
    else:
        _run_loop()

    # ── 10. Final cache save ──────────────────────────────────────────────────
    _save_cache(cache)
    logger.info("News/sentiment cache saved: %d entries.", len(cache))

    # ── Signal statistics ─────────────────────────────────────────────────────
    _suppressed = _signal_stats["total"] - _signal_stats["passed"]
    logger.info("═══════════════════════════════════════════")
    logger.info("  SIGNAL STATISTICS (full simulation)")
    logger.info("  Total signals evaluated : %d", _signal_stats["total"])
    logger.info("  Passed alpha threshold  : %d (≥%.2f)", _signal_stats["passed"], effective_buy_threshold)
    logger.info("  Suppressed (below thr.) : %d", _suppressed)
    if _signal_stats["total"] > 0:
        pass_rate = _signal_stats["passed"] / _signal_stats["total"] * 100
        logger.info("  Pass rate               : %.1f%%", pass_rate)
    logger.info("═══════════════════════════════════════════")

    # ── 11. Summary ───────────────────────────────────────────────────────────
    final_value = wallet.portfolio_value(current_prices)
    total_return = (final_value - initial_capital) / initial_capital * 100
    logger.info("═══════════════════════════════════════════")
    logger.info("  BACKTEST COMPLETE")
    logger.info("  Final portfolio value : $%s", format(final_value, ",.2f"))
    logger.info("  Total return          : %+.2f%%", total_return)
    logger.info("  Open positions        : %d", len(wallet.positions))
    logger.info("═══════════════════════════════════════════")


# ── CLI entry point ────────────────────────────────────────────────────────────

if __name__ == "__main__":
    parser = argparse.ArgumentParser(description="TFG Backtest Engine (Quant Lab)")
    parser.add_argument("--start",            default="2023-01-01", help="Simulation start date (YYYY-MM-DD).")
    parser.add_argument("--end",              default=None,          help="Simulation end date (YYYY-MM-DD). Default: today.")
    parser.add_argument("--capital",          type=float, default=100_000.0, help="Initial capital in USD.")
    parser.add_argument("--atr-multiplier",   type=float, default=2.5,       help="ATR multiplier for trailing stop.")
    parser.add_argument("--trend-sma",        type=int,   default=50,        choices=[20, 50, 100, 200], help="SMA period for macro filter.")
    parser.add_argument("--min-holding-days", type=int,   default=3,         help="Minimum holding days before sell fires.")
    parser.add_argument("--confirmation-days",type=int,   default=2,         help="Consecutive days above threshold for BUY confirmation.")
    parser.add_argument("--alpha-factor",     type=float, default=1.0,       help="AI aggressiveness (scales buy threshold as 0.60/alpha).")
    parser.add_argument("--beta-factor",        type=float, default=1.0,  help="Volatility appetite (scales order size by beta).")
    parser.add_argument("--max-allocation-pct", type=float, default=0.20, help="Max capital allocation per position (0.10–0.50).")
    parser.add_argument("--take-profit-pct",    type=float, default=0.30, help="Take-profit target above entry price (0.10–0.50).")
    parser.add_argument("--sentiment-weight",   type=float, default=0.0,  help="Sentiment fusion weight ω (0.0–1.0).")
    args = parser.parse_args()

    run_backtest(
        start=date.fromisoformat(args.start),
        end=date.fromisoformat(args.end) if args.end else None,
        initial_capital=args.capital,
        atr_multiplier=args.atr_multiplier,
        trend_sma=args.trend_sma,
        min_holding_days=args.min_holding_days,
        confirmation_days=args.confirmation_days,
        alpha_factor=args.alpha_factor,
        beta_factor=args.beta_factor,
        max_allocation_pct=args.max_allocation_pct,
        take_profit_pct=args.take_profit_pct,
        sentiment_weight=args.sentiment_weight,
    )

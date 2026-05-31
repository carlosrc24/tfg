"""
data/market_data.py – OHLC price ingestion via yfinance.

Uses yfinance for historical data (reliable, no key needed) and alpaca-py
for real-time / live bar data when the market is open.
"""
from __future__ import annotations

import logging
from datetime import datetime, timedelta, timezone

import pandas as pd
import yfinance as yf
from alpaca.data.historical import StockHistoricalDataClient
from alpaca.data.requests import StockBarsRequest
from alpaca.data.timeframe import TimeFrame
from alpaca.data.enums import DataFeed

from config import ALPACA_API_KEY, ALPACA_SECRET_KEY, LOOKBACK_DAYS

logger = logging.getLogger(__name__)

# Alpaca data client (market data, not trading)
_alpaca_data_client: StockHistoricalDataClient | None = None


def _get_alpaca_data_client() -> StockHistoricalDataClient:
    global _alpaca_data_client
    if _alpaca_data_client is None:
        _alpaca_data_client = StockHistoricalDataClient(
            api_key=ALPACA_API_KEY,
            secret_key=ALPACA_SECRET_KEY,
        )
    return _alpaca_data_client


# ── Public API ────────────────────────────────────────────────────────────────

def fetch_ohlc_yfinance(symbol: str, days: int = LOOKBACK_DAYS) -> pd.DataFrame:
    """
    Download *days* of daily OHLC bars from Yahoo Finance.

    Returns a DataFrame with columns: Open, High, Low, Close, Volume
    indexed by a tz-aware DatetimeIndex (UTC).
    """
    end = datetime.now(tz=timezone.utc)
    start = end - timedelta(days=days)
    
    # Use yf.download instead of ticker.history to bypass aggressive rate limits
    df = yf.download(symbol, start=start, end=end, interval="1d", auto_adjust=True)

    if df.empty:
        raise ValueError(f"yfinance returned no data for {symbol}")
        
    # yfinance >= 0.2 returns MultiIndex columns for download()
    if isinstance(df.columns, pd.MultiIndex):
        df.columns = df.columns.get_level_values(0)

    # Normalise index to UTC
    if df.index.tz is None:
        df.index = df.index.tz_localize("UTC")
    else:
        df.index = df.index.tz_convert("UTC")

    df = df[["Open", "High", "Low", "Close", "Volume"]].rename(
        columns=str.lower
    )
    logger.info("yfinance: fetched %d bars for %s", len(df), symbol)
    return df


def fetch_ohlc_alpaca(symbol: str, days: int = LOOKBACK_DAYS) -> pd.DataFrame:
    """
    Download *days* of daily OHLC bars from Alpaca Markets.

    Falls back gracefully to yfinance if Alpaca is unavailable.
    """
    try:
        client = _get_alpaca_data_client()
        end = datetime.now(tz=timezone.utc)
        start = end - timedelta(days=days)

        request = StockBarsRequest(
            symbol_or_symbols=symbol,
            timeframe=TimeFrame.Day,
            start=start,
            end=end,
            feed=DataFeed.IEX,
        )
        bars = client.get_stock_bars(request)
        df = bars.df

        if isinstance(df.index, pd.MultiIndex):
            df = df.loc[symbol]

        df = df[["open", "high", "low", "close", "volume"]]
        logger.info("Alpaca: fetched %d bars for %s", len(df), symbol)
        return df

    except Exception as exc:
        logger.warning(
            "Alpaca data fetch failed for %s (%s). Falling back to yfinance.", symbol, exc
        )
        return fetch_ohlc_yfinance(symbol, days)


def get_latest_price(symbol: str) -> float:
    """Return the most recent closing price for *symbol*."""
    df = fetch_ohlc_yfinance(symbol, days=5)
    return float(df["close"].iloc[-1])

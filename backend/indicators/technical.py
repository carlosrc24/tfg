"""
indicators/technical.py – TA-Lib indicator calculation pipeline.

Computes:
  • RSI  (14) Te dice si la gente ha comprado o vendido demasiado un activo en los últimos 14 días.
  • ADX  (14) Te dice con cuánta fuerza se está moviendo (ya sea para arriba o abajo).
  • SMA  (50 and 200) Es el precio promedio de los últimos 50 o 200 días (tendencia a medio/largo plazo).
  • MACD (12, 26, 9)  → stored as macd_line, macd_signal, macd_hist Convergencia/Divergencia del Promedio Móvil. Son dos líneas que se van cruzando. Si la línea MACD cruza hacia arriba de la señal, es hora de comprar
  • Bollinger Bands (20, 2σ) Crean un canal alrededor del precio usando una media de 20 días y una desviación estándar. Si toca la banda superior, está caro; si toca la inferior, está barato.
  • ATR  (14) El ATR mide la volatilidad de un activo. Mide cuánto se mueve un activo (su volatilidad) en promedio por día. Si el ATR de una acción es de 5$, significa que un día normal suele moverse arriba o abajo unos 5$
  • Candle Patterns: DOJI, HAMMER, ENGULFING (bullish & bearish)

Quantitative Finance additions:
  • Beta Dinámica (CAPM): beta_30d, beta_90d — covariance/variance of returns
    vs. SPY benchmark, computed on rolling windows of 30 and 90 days.
    Beta te dice qué tan sensible o "nerviosa" es una acción cuando el mercado se mueve. 
    Beta 1 = se mueve igual que el mercado.
    Beta > 1 = más volátil que el mercado (sube más fuerte si el mercado sube, y baja más fuerte si baja).
    Beta < 1 = más estable que el mercado.
  • GBM Volatility: volatility_30d — annualised σ of log-returns (Geometric
    Brownian Motion assumption): σ = std(ln(P_t / P_{t-1})) × sqrt(252).
    Imagina que haces todo ese cálculo y el resultado de la volatilidad ($\sigma$) es 0.25 (o 25%).Eso significa que, asumiendo que la acción se sigue moviendo como lo hizo en los últimos 30 días, el mercado espera que durante el próximo año el precio de la acción fluctúe (suba o baje) aproximadamente un 25% respecto a su precio actual.Si es baja (ej. 10%): Es una acción aburrida y segura (como una empresa de electricidad).Si es alta (ej. 80%): Es una acción adrenalínica y peligrosa (como una empresa de biotecnología o una criptomoneda).
"""
from __future__ import annotations

import logging

import numpy as np
import pandas as pd
import talib

logger = logging.getLogger(__name__)


def compute_indicators(df: pd.DataFrame) -> pd.DataFrame:
    """
    Add all TA-Lib indicators to *df* (in-place copy) and return it.

    *df* must have lowercase columns: open, high, low, close, volume
    and must contain at least 200 rows for SMA-200 to be valid.
    """
    df = df.copy()

    o = df["open"].values.astype(float)
    h = df["high"].values.astype(float)
    l = df["low"].values.astype(float)
    c = df["close"].values.astype(float)

    # ── Trend ─────────────────────────────────────────────────────────────────
    df["sma_50"]  = talib.SMA(c, timeperiod=50)
    df["sma_100"] = talib.SMA(c, timeperiod=100)
    df["sma_200"] = talib.SMA(c, timeperiod=200)

    # ── Momentum ──────────────────────────────────────────────────────────────
    df["rsi"] = talib.RSI(c, timeperiod=14)

    macd, macd_signal, macd_hist = talib.MACD(c, fastperiod=12, slowperiod=26, signalperiod=9)
    df["macd_line"]   = macd
    df["macd_signal"] = macd_signal
    df["macd_hist"]   = macd_hist

    # ── Volatility ────────────────────────────────────────────────────────────
    df["atr"] = talib.ATR(h, l, c, timeperiod=14)

    bb_upper, bb_middle, bb_lower = talib.BBANDS(c, timeperiod=20, nbdevup=2, nbdevdn=2)
    df["bb_upper"]  = bb_upper
    df["bb_middle"] = bb_middle
    df["bb_lower"]  = bb_lower
    # Bandwidth: (upper - lower) / middle
    df["bb_width"]  = (bb_upper - bb_lower) / bb_middle
    # %B: (close - lower) / (upper - lower)
    df["bb_pct"]    = (c - bb_lower) / (bb_upper - bb_lower)

    # ── Directional ───────────────────────────────────────────────────────────
    df["adx"] = talib.ADX(h, l, c, timeperiod=14)

    # ── Candle Patterns ───────────────────────────────────────────────────────
    # TA-Lib returns 0, 100, -100 (or multiples). Normalise to -1, 0, 1.
    df["cdl_doji"]     = talib.CDLDOJI(o, h, l, c)     / 100
    df["cdl_hammer"]   = talib.CDLHAMMER(o, h, l, c)   / 100
    df["cdl_engulfing"] = talib.CDLENGULFING(o, h, l, c) / 100

    # ── Returns (target variable proxy) ───────────────────────────────────────
    df["returns_1d"] = df["close"].pct_change(1)
    df["target"]     = (df["returns_1d"].shift(-1) > 0).astype(int)  # tomorrow up?

    logger.debug("Indicators computed. Shape: %s", df.shape)
    return df


def compute_gbm_volatility(df: pd.DataFrame, window: int = 30) -> pd.Series:
    """
    Compute annualised volatility using the Geometric Brownian Motion assumption.

    σ = std(ln(P_t / P_{t-1}), window) × sqrt(252)

    Returns a pd.Series named 'volatility_30d' aligned with df.index.
    """
    log_returns = np.log(df["close"] / df["close"].shift(1))
    vol = log_returns.rolling(window=window, min_periods=max(5, window // 2)).std() * np.sqrt(252)
    vol.name = f"volatility_{window}d"
    return vol


def compute_beta(
    df_etf: pd.DataFrame,
    df_spy: pd.DataFrame,
    window: int = 30,
) -> pd.Series:
    """
    Compute the CAPM rolling Beta of *df_etf* relative to *df_spy*.

    β_t = Cov(r_etf, r_spy, window) / Var(r_spy, window)

    Both DataFrames must have a 'close' column and a compatible DatetimeIndex.
    Returns a pd.Series named 'beta_{window}d' aligned with df_etf.index.
    """
    etf_ret = df_etf["close"].pct_change()
    spy_ret = df_spy["close"].reindex(df_etf.index, method="ffill").pct_change()

    # Rolling covariance and variance
    rolling_cov = etf_ret.rolling(window=window, min_periods=max(5, window // 2)).cov(spy_ret)
    rolling_var = spy_ret.rolling(window=window, min_periods=max(5, window // 2)).var()

    beta = rolling_cov / rolling_var.replace(0, np.nan)
    beta.name = f"beta_{window}d"
    return beta


def get_latest_indicators(
    df: pd.DataFrame,
    df_spy: pd.DataFrame | None = None,
) -> dict:
    """
    Return a dict of the most recent (last row) indicator values,
    ready to be inserted into market_intelligence.

    Parameters
    ----------
    df      : OHLCV DataFrame for the ETF being processed.
    df_spy  : Optional OHLCV DataFrame for SPY. When provided, Beta and
              GBM Volatility are also computed and included in the output.
    """
    computed = compute_indicators(df)
    row = computed.iloc[-1]

    result = {
        "close_price":   _safe(row, "close"),
        "rsi":           _safe(row, "rsi"),
        "adx":           _safe(row, "adx"),
        "sma_50":        _safe(row, "sma_50"),
        "sma_100":       _safe(row, "sma_100"),
        "sma_200":       _safe(row, "sma_200"),
        "atr":           _safe(row, "atr"),
        "macd_line":     _safe(row, "macd_line"),
        "macd_signal":   _safe(row, "macd_signal"),
        "macd_hist":     _safe(row, "macd_hist"),
        "bb_upper":      _safe(row, "bb_upper"),
        "bb_lower":      _safe(row, "bb_lower"),
        "bb_width":      _safe(row, "bb_width"),
        "bb_pct":        _safe(row, "bb_pct"),
        "cdl_doji":      _safe(row, "cdl_doji"),
        "cdl_hammer":    _safe(row, "cdl_hammer"),
        "cdl_engulfing": _safe(row, "cdl_engulfing"),
        # Quant features — populated below if df_spy is available
        "beta_30d":       None,
        "beta_90d":       None,
        "volatility_30d": None,
    }

    if df_spy is not None and len(df) >= 30:
        try:
            vol_series  = compute_gbm_volatility(df, window=30)
            beta30      = compute_beta(df, df_spy, window=30)
            beta90      = compute_beta(df, df_spy, window=90)

            result["volatility_30d"] = _safe_series(vol_series)
            result["beta_30d"]       = _safe_series(beta30)
            result["beta_90d"]       = _safe_series(beta90)
        except Exception as exc:
            logger.warning("Could not compute quant features: %s", exc)

    return result


def _safe(row: pd.Series, col: str) -> float | None:
    """Return float or None if NaN."""
    val = row.get(col)
    if val is None or (isinstance(val, float) and np.isnan(val)):
        return None
    return float(val)


def _safe_series(s: pd.Series) -> float | None:
    """Return the last non-NaN value of a series, or None."""
    if s is None or s.empty:
        return None
    last = s.dropna()
    if last.empty:
        return None
    return float(last.iloc[-1])

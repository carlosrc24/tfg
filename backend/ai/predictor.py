"""
ai/predictor.py – LightGBM binary classifier (Quant-Enhanced v2).

Target: P(next-day return > 0)  →  "probability of going up"

Feature set (v2 — aligned with backtest_engine quant pipeline):
  Technical:   rsi, adx, sma_50, sma_200, atr,
               macd_hist, bb_width, bb_pct,
               cdl_doji, cdl_hammer, cdl_engulfing
  NLP:         sentiment_score       (FinBERT raw score)
               sentiment_ema_5d      (EMA-5 of sentiment — denoised)
  Quant:       beta_30d, beta_90d    (CAPM rolling beta vs SPY)
               volatility_30d        (GBM annualised σ)

Decision rules applied OUTSIDE the model (in predict_proba_filtered()):
  1. Trend Filter (Death Cross):  if SMA-50 < SMA-200 → suppress BUY signals.
     The model score is still returned but the caller knows the regime.

Workflow:
  1. On first run the model trains on all rows in market_intelligence.
  2. The trained model is persisted to MODEL_PATH (joblib).
  3. On subsequent runs the model is loaded and used for inference.
  4. Re-training is triggered automatically when the dataset grows by
     RETRAIN_THRESHOLD rows since last training.
"""
from __future__ import annotations

import logging
import os
from typing import Any

import joblib
import numpy as np
import pandas as pd
from lightgbm import LGBMClassifier
from sklearn.metrics import roc_auc_score
from sklearn.model_selection import TimeSeriesSplit

from config import MODEL_PATH

logger = logging.getLogger(__name__)

# ── Feature columns (must match what backtest_engine feeds at inference time) ──
FEATURE_COLS: list[str] = [
    # TA-Lib technical indicators
    "rsi", "adx", "sma_50", "sma_100", "sma_200", "atr",
    "macd_hist", "bb_width", "bb_pct",
    "cdl_doji", "cdl_hammer", "cdl_engulfing",
    # NLP
    "sentiment_score",
    "sentiment_ema_5d",
    # Quant
    "beta_30d",
    "beta_90d",
    "volatility_30d",
]

RETRAIN_THRESHOLD: int = 20  # re-train every N new rows

_model: LGBMClassifier | None = None
_rows_at_last_train: int = 0


def _build_model() -> LGBMClassifier:
    return LGBMClassifier(
        n_estimators=400,
        learning_rate=0.04,
        max_depth=5,
        num_leaves=20,
        subsample=0.8,
        colsample_bytree=0.8,
        min_child_samples=30,   # prevents over-fitting on small subsets
        reg_alpha=0.1,          # L1 regularisation
        reg_lambda=0.2,         # L2 regularisation
        random_state=42,
        verbose=-1,
    )


def _add_sentiment_ema(df: pd.DataFrame) -> pd.DataFrame:
    """
    Compute a 5-day Exponential Moving Average of sentiment_score and add it
    as 'sentiment_ema_5d'.  Works on an already-sorted-by-timestamp DataFrame.
    """
    if "sentiment_score" not in df.columns:
        df["sentiment_ema_5d"] = 0.0
        return df
    alpha = 2 / (5 + 1)
    df["sentiment_ema_5d"] = (
        df["sentiment_score"]
        .fillna(0.0)
        .ewm(alpha=alpha, adjust=False)
        .mean()
    )
    return df


def train(records: list[dict[str, Any]]) -> LGBMClassifier:
    """
    Train (or re-train) the LightGBM model on *records* from Supabase.

    *records* should be the raw rows from market_intelligence, already
    including sentiment_score.  The function computes:
      - 'target'          : 1 if next close > current close
      - 'sentiment_ema_5d': EMA-5 of sentiment_score

    Quant features (beta_30d, beta_90d, volatility_30d) are expected to be
    pre-computed by the backtest engine or the live worker and stored in the
    records dict.  If missing, they default to 0.0 (neutral).
    """
    global _model, _rows_at_last_train

    df = pd.DataFrame(records)

    if df.empty:
        logger.warning("No records found to train on.")
        return _model  # type: ignore

    # Sort chronologically so EMA and target shift are correct
    if "timestamp" in df.columns:
        df = df.sort_values("timestamp").reset_index(drop=True)

    # Compute target if missing: 1 if next close > current close
    if "target" not in df.columns:
        df["target"] = (df["close_price"].shift(-1) > df["close_price"]).astype(int)

    # Compute EMA-denoised sentiment
    df = _add_sentiment_ema(df)

    # Fill missing quant features with neutral values
    for col in ("beta_30d", "beta_90d", "volatility_30d"):
        if col not in df.columns:
            df[col] = 0.0
        df[col] = df[col].fillna(0.0)

    # sma_100 may be absent in older Supabase rows — fill with 0.0 (handled by model as neutral)
    if "sma_100" not in df.columns:
        df["sma_100"] = 0.0
    df["sma_100"] = df["sma_100"].fillna(0.0)

    # ── Normalize price-based features by close_price ─────────────────────────
    # sma_50/100/200, atr, and macd_hist are in absolute dollar terms.  A model
    # trained on all 8 ETFs together learns price-level splits (SPY $420 vs ARKK
    # $35) rather than signal patterns, causing permanently extreme probabilities
    # for specific ETFs in out-of-sample periods.  Dividing by close_price makes
    # every ETF comparable at every price level and eliminates covariate shift.
    #   sma ratio  = close / sma   → >1 means price above SMA (bullish), ~0.9-1.1
    #   atr_frac   = atr / close   → ATR as fraction of price, ~0.005-0.05
    #   macd_frac  = macd / close  → signed momentum fraction, ~-0.01 to 0.01
    if "close_price" in df.columns:
        cp = df["close_price"].replace(0, np.nan)
        for col in ("sma_50", "sma_100", "sma_200"):
            if col in df.columns:
                df[col] = (cp / df[col].replace(0, np.nan)).fillna(1.0)
        for col in ("atr", "macd_hist"):
            if col in df.columns:
                df[col] = (df[col] / cp).fillna(0.0)

    # ── Feature scaling for quant features ────────────────────────────────────
    # LightGBM is tree-based and scale-invariant, BUT extreme outliers in Beta
    # (e.g. Beta=8.0 during a crash) can push the model to rely on one feature
    # split and ignore the rest.  Winsorise so the range stays comparable to
    # RSI (0-100) or ADX (0-100).
    #   beta:       clip to [-3, 3]  — typical ETF range is [0.5, 2.0]
    #   volatility: clip to [0, 1.5] — 150% annualised is extreme; ETFs ~15-40%
    df["beta_30d"]       = df["beta_30d"].clip(-3.0, 3.0)
    df["beta_90d"]       = df["beta_90d"].clip(-3.0, 3.0)
    df["volatility_30d"] = df["volatility_30d"].clip(0.0, 1.5)

    # Drop rows with NaN in core features or target
    available_cols = [c for c in FEATURE_COLS if c in df.columns]
    df_clean = df[available_cols + ["target"]].dropna()

    if len(df_clean) < 50:
        logger.warning("Not enough clean rows (%d) to train. Skipping.", len(df_clean))
        return _model  # type: ignore

    X = df_clean[available_cols].values
    y = df_clean["target"].values


    model = _build_model()

    # Time-series cross-validation for evaluation
    tscv = TimeSeriesSplit(n_splits=3)
    auc_scores = []
    for train_idx, val_idx in tscv.split(X):
        model.fit(X[train_idx], y[train_idx])
        val_probs = model.predict_proba(X[val_idx])[:, 1]
        auc_scores.append(roc_auc_score(y[val_idx], val_probs))

    mean_auc = float(np.mean(auc_scores))
    logger.info("LightGBM CV AUC: %.4f (over %d samples)", mean_auc, len(df_clean))

    # Final fit on all data
    model.fit(X, y)
    _model = model
    _rows_at_last_train = len(df_clean)

    # Persist
    os.makedirs(os.path.dirname(MODEL_PATH), exist_ok=True)
    joblib.dump(model, MODEL_PATH)
    logger.info("Model saved to %s", MODEL_PATH)

    return model


def load_or_train(records: list[dict[str, Any]]) -> LGBMClassifier | None:
    """Load the persisted model or train a new one."""
    global _model, _rows_at_last_train

    if _model is not None:
        if len(records) - _rows_at_last_train >= RETRAIN_THRESHOLD:
            logger.info("Re-training model (new rows: %d).", len(records) - _rows_at_last_train)
            return train(records)
        return _model

    if os.path.exists(MODEL_PATH):
        logger.info("Loading model from %s", MODEL_PATH)
        _model = joblib.load(MODEL_PATH)
        _rows_at_last_train = len(records)
        return _model

    logger.info("No saved model found. Training from scratch …")
    return train(records)


def predict_proba(features: dict[str, Any]) -> float:
    """
    Predict the probability of an upward price move for a single observation.

    Returns a float in [0, 1], or 0.5 if the model is not yet available.

    Applies the same winsorisation as train() so the model sees consistent
    feature distributions at inference time.
    """
    if _model is None:
        logger.warning("Model not trained yet. Returning neutral probability 0.5.")
        return 0.5

    close = float(features.get("close_price") or 0.0)

    def _normalize(col: str, val: float) -> float:
        """Mirror the normalization applied during train() so features are scale-invariant."""
        if close > 0:
            if col in ("sma_50", "sma_100", "sma_200"):
                return (close / val) if val > 0 else 1.0
            if col in ("atr", "macd_hist"):
                return val / close
        return val

    def _clip(col: str, val: float) -> float:
        if col in ("beta_30d", "beta_90d"):
            return max(-3.0, min(3.0, val))
        if col == "volatility_30d":
            return max(0.0, min(1.5, val))
        return val

    row = [[_clip(col, _normalize(col, features.get(col, 0.0) or 0.0)) for col in FEATURE_COLS]]
    prob = float(_model.predict_proba(row)[0][1])
    logger.debug("Prediction probability: %.4f", prob)
    return prob



def predict_proba_filtered(features: dict[str, Any]) -> tuple[float, bool]:
    """
    Enhanced prediction that applies the Trend Filter (Price > SMA-100).

    Using Price > SMA-100 as the trend filter is more reactive than the
    classic Death Cross (SMA-50 vs SMA-200), allowing the bot to enter
    rising trends much earlier while still avoiding strong downtrends.

    Returns
    -------
    prob          : raw model probability in [0, 1]
    trend_bullish : True if close_price > SMA-100 (uptrend — BUY signals allowed)
                   False if close_price < SMA-100 (downtrend — BUY signals suppressed)

    The caller (backtest_engine / alpaca_trader) is responsible for acting on
    the trend flag.  This keeps the filter logic visible and testable.
    """
    prob = predict_proba(features)

    close_price = features.get("close_price") or 0.0
    sma_100     = features.get("sma_100")     or 0.0

    # If SMA-100 is missing/zero (not enough data), assume bullish
    if sma_100 == 0.0 or close_price == 0.0:
        trend_bullish = True
    else:
        trend_bullish = close_price > sma_100

    return prob, trend_bullish

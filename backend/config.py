"""
config.py – Centralised configuration loader.
All environment variables are read once here and exposed as typed constants.
"""
import os
from dotenv import load_dotenv

# Load .env from the project root (mounted at /app in Docker)
load_dotenv()

# ── Supabase ──────────────────────────────────────────────────────────────────
SUPABASE_URL: str = os.environ["SUPABASE_URL"]
SUPABASE_KEY: str = os.environ["SUPABASE_KEY"]          # service_role or anon key
SUPABASE_DB_PASSWORD: str = os.environ["SUPABASE_PASSWORD_DB"]

# ── Alpaca Paper Trading ───────────────────────────────────────────────────────
ALPACA_API_KEY: str = os.environ["API_KEY_ALPACA"]
ALPACA_SECRET_KEY: str = os.environ["SECRET_API_KEY_ALPACA"]
ALPACA_BASE_URL: str = os.environ.get("ALPACA_ENDPOINT", "https://paper-api.alpaca.markets")

# ── FRED ──────────────────────────────────────────────────────────────────────
FRED_API_KEY: str = os.environ["FRED_API_KEY"]

# ── Trading Parameters ────────────────────────────────────────────────────────
# ETFs tracked by the system
ETF_SYMBOLS: list[str] = ["QQQ", "SPY", "IWM", "GLD", "XLF", "SMH","XLE","ARKK"]

# LightGBM probability threshold to trigger a BUY
BUY_THRESHOLD: float = float(os.environ.get("BUY_THRESHOLD", "0.60"))
SELL_THRESHOLD: float = float(os.environ.get("SELL_THRESHOLD", "0.40"))

# Worker schedule (minutes between each full run)
WORKER_INTERVAL_MINUTES: int = int(os.environ.get("WORKER_INTERVAL_MINUTES", "30"))

# Historical data window for indicator calculation (trading days)
LOOKBACK_DAYS: int = int(os.environ.get("LOOKBACK_DAYS", "300"))

# FinBERT model identifier
FINBERT_MODEL: str = "ProsusAI/finbert"

# LightGBM model persistence path
MODEL_PATH: str = os.environ.get("MODEL_PATH", "/app/models/lgbm_model.pkl")

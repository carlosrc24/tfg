# tfg
Trabajo final de grado de Ingeniería Informática donde se hace un pipeline de inversión junto con un dashboard 

# ─────────────────────────────────────────────────────────────
# EJEMPLO DE .env:
# Por cuestiones de seguridad solo se ofrece un esqueleto
# ─────────────────────────────────────────────────────────────
# Contraseña de la base de datos (usada por el backend Python)
SUPABASE_PASSWORD_DB=xxxx

# URL del proyecto Supabase (ej: https://xxxx.supabase.co)
SUPABASE_URL=https://xxxx.supabase.co

# Service Role Key (para el backend Python - acceso total)
SUPABASE_KEY=xxxx

# Anon Key (para el frontend Next.js - acceso público)
NEXT_PUBLIC_SUPABASE_URL=https://xxxx.supabase.co
NEXT_PUBLIC_SUPABASE_ANON_KEY=xxxxx

# ─────────────────────────────────────────────────────────────
# Alpaca Paper Trading
# ─────────────────────────────────────────────────────────────
ALPACA_ENDPOINT=https://paper-api.alpaca.markets/v2
API_KEY_ALPACA=xxxx
SECRET_API_KEY_ALPACA=xxxx

# ─────────────────────────────────────────────────────────────
# FRED API
# ─────────────────────────────────────────────────────────────
FRED_API_KEY=xxxx

# ─────────────────────────────────────────────────────────────
# Worker Parameters (optional overrides)
# ─────────────────────────────────────────────────────────────
BUY_THRESHOLD=0.60
SELL_THRESHOLD=0.40
WORKER_INTERVAL_MINUTES=30
LOOKBACK_DAYS=300
MODEL_PATH=/app/models/lgbm_model.pkl

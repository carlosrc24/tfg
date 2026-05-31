"""
purge_2023_data.py – Borra todos los datos posteriores al 1 de enero de 2023 de la base de datos.

Se usa para limpiar los datos antes de ejecutar el backtesting puro (solo años 2012–2022).

El script borra de forma segura:                                                                 
  • trades (todos los trades con timestamp >= 2023-01-01)
  • equity_history (todos los snapshots con timestamp >= 2023-01-01)
  • market_intelligence (todas las observaciones con timestamp >= 2023-01-01)

Los datos de 2022 y anteriores NO se tocan.

Uso:
  python purge_2023_data.py
"""

import logging
import sys
from pathlib import Path

BACKEND_DIR = Path(__file__).resolve().parent
sys.path.insert(0, str(BACKEND_DIR))

from db.supabase_client import get_client

logging.basicConfig(level=logging.INFO, format="%(message)s")
logger = logging.getLogger("purge")

def purge_all_2023_data():
    client = get_client()
    target_date = "2023-01-01T00:00:00Z"
    
    logger.info("=============================================")
    logger.info("🗑️  PURGING ALL DATA >= 2023-01-01 FROM DB")
    logger.info("=============================================")

    try:
        logger.info("Deleting from 'trades'...")
        res_trades = client.table("trades").delete().gte("timestamp", target_date).execute()
        
        logger.info("Deleting from 'equity_history'...")
        res_eq = client.table("equity_history").delete().gte("timestamp", target_date).execute()
        
        logger.info("Deleting from 'market_intelligence'...")
        res_mi = client.table("market_intelligence").delete().gte("timestamp", target_date).execute()
        
        logger.info("✅ Database is now 100% clean of any 2023-2026 data.")
        logger.info("You are ready to train the pure historical model and run the backtest.")
    except Exception as e:
        logger.error(f"Error purging database: {e}")

if __name__ == "__main__":
    purge_all_2023_data()

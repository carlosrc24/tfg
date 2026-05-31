"""
reset_backtest.py – Safely purge all backtest data from Supabase.

Deletes ONLY rows where is_backtest = TRUE from:
  • trades
  • equity_history

Live/paper trading data (is_backtest = FALSE or NULL) is NEVER touched.

Usage:
    python reset_backtest.py              # asks for confirmation
    python reset_backtest.py --yes        # skip confirmation (CI/CD)
"""
from __future__ import annotations

import argparse
import sys
from pathlib import Path

BACKEND_DIR = Path(__file__).resolve().parent
sys.path.insert(0, str(BACKEND_DIR))

from db.supabase_client import get_client


def reset_backtest(skip_confirm: bool = False) -> None:
    if not skip_confirm:
        print("\n⚠️  This will DELETE all rows where is_backtest = TRUE from:")
        print("     • trades")
        print("     • equity_history")
        print("\n   Live data (is_backtest = FALSE) will NOT be affected.\n")
        answer = input("Type 'yes' to confirm: ").strip().lower()
        if answer != "yes":
            print("Aborted.")
            sys.exit(0)

    client = get_client()

    resp_trades = (
        client.table("trades")
        .delete()
        .eq("is_backtest", True)
        .execute()
    )
    n_trades = len(resp_trades.data) if resp_trades.data else 0

    resp_equity = (
        client.table("equity_history")
        .delete()
        .eq("is_backtest", True)
        .execute()
    )
    n_equity = len(resp_equity.data) if resp_equity.data else 0

    print(f"\n✅  Reset complete:")
    print(f"    Deleted {n_trades:,} backtest trades")
    print(f"    Deleted {n_equity:,} backtest equity snapshots\n")


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description="Reset all backtest data from Supabase.")
    parser.add_argument("--yes", action="store_true", help="Skip confirmation prompt.")
    args = parser.parse_args()
    reset_backtest(skip_confirm=args.yes)

"""
db/supabase_client.py – Supabase client singleton and CRUD helpers.
"""
from __future__ import annotations

import logging
from typing import Any

from supabase import create_client, Client

from config import SUPABASE_URL, SUPABASE_KEY

logger = logging.getLogger(__name__)

# ── Singleton client ──────────────────────────────────────────────────────────
_client: Client | None = None


def get_client() -> Client:
    """Return the shared Supabase client, creating it once if needed."""
    global _client
    if _client is None:
        _client = create_client(SUPABASE_URL, SUPABASE_KEY)
        logger.info("Supabase client initialised.")
    return _client


# ── ETFs helpers ──────────────────────────────────────────────────────────────

def upsert_etf(symbol: str, name: str) -> dict[str, Any]:
    """Insert or update an ETF record. Returns the row."""
    client = get_client()
    response = (
        client.table("etfs")
        .upsert({"symbol": symbol, "name": name}, on_conflict="symbol")
        .execute()
    )
    row = response.data[0]
    logger.debug("Upserted ETF %s → id=%s", symbol, row["id"])
    return row


def get_etf_id(symbol: str) -> str | None:
    """Return the UUID of an ETF by symbol, or None if not found."""
    client = get_client()
    response = (
        client.table("etfs")
        .select("id")
        .eq("symbol", symbol)
        .maybe_single()
        .execute()
    )
    if response.data:
        return response.data["id"]
    return None


# ── market_intelligence helpers ───────────────────────────────────────────────

def upsert_market_intelligence(record: dict[str, Any]) -> dict[str, Any]:
    """
    Insert or update a market_intelligence row.

    Expected keys in *record*:
        etf_id, timestamp, close_price,
        rsi, adx, sma_50, sma_200, atr,
        sentiment_score, prediction_prob
    """
    client = get_client()
    response = (
        client.table("market_intelligence")
        .upsert(record, on_conflict="etf_id,timestamp")
        .execute()
    )
    row = response.data[0]
    logger.debug(
        "Upserted market_intelligence for etf_id=%s @ %s",
        record.get("etf_id"),
        record.get("timestamp"),
    )
    return row


def fetch_recent_intelligence(etf_id: str, limit: int = 200) -> list[dict[str, Any]]:
    """Fetch the most recent rows for an ETF (for model training/inference)."""
    client = get_client()
    response = (
        client.table("market_intelligence")
        .select("*")
        .eq("etf_id", etf_id)
        .order("timestamp", desc=True)
        .limit(limit)
        .execute()
    )
    return response.data


# ── trades helpers ─────────────────────────────────────────────────────────────

def insert_trade(record: dict[str, Any]) -> dict[str, Any]:
    """
    Insert a trade record.

    Expected keys: etf_id, action, price, quantity
    Optional keys: profit_loss
    """
    client = get_client()
    response = client.table("trades").insert(record).execute()
    row = response.data[0]
    logger.info(
        "Trade recorded: %s %s @ %.4f (qty=%s)",
        record.get("action"),
        record.get("etf_id"),
        record.get("price"),
        record.get("quantity"),
    )
    return row


def fetch_open_trades(etf_id: str) -> list[dict[str, Any]]:
    """Return trades without a profit_loss (i.e. still open)."""
    client = get_client()
    response = (
        client.table("trades")
        .select("*")
        .eq("etf_id", etf_id)
        .is_("profit_loss", "null")
        .order("timestamp", desc=True)
        .execute()
    )
    return response.data


# ── equity_history helpers ─────────────────────────────────────────────────────

# ── backtest_runs helpers ──────────────────────────────────────────────────────

def create_backtest_run(run_id: str, parameters: dict[str, Any]) -> dict[str, Any]:
    """Insert a new backtest_runs row with status='queued'."""
    client = get_client()
    response = client.table("backtest_runs").insert({
        "id": run_id,
        "status": "queued",
        "progress_pct": 0,
        "terminal_logs": "",
        "parameters": parameters,
    }).execute()
    return response.data[0]


def update_backtest_run(run_id: str, fields: dict[str, Any]) -> None:
    """Partial update of a backtest_runs row."""
    client = get_client()
    client.table("backtest_runs").update(fields).eq("id", run_id).execute()


def get_backtest_run(run_id: str) -> dict[str, Any] | None:
    """Fetch a single backtest_runs row by id."""
    client = get_client()
    result = (
        client.table("backtest_runs")
        .select("*")
        .eq("id", run_id)
        .maybe_single()
        .execute()
    )
    return result.data


# ── equity_history helpers ─────────────────────────────────────────────────────

def upsert_equity_snapshot(total_value: float, benchmark_value: float | None = None) -> dict[str, Any]:
    """
    Insert or update today's equity snapshot.

    Uses ON CONFLICT on the unique date index so only one row per calendar day
    is kept (the most recent value of that day wins).
    """
    from datetime import date
    client = get_client()
    today = date.today().isoformat()   # "YYYY-MM-DD"

    # Try to update today's row first; if it doesn't exist, insert.
    existing = (
        client.table("equity_history")
        .select("id")
        .gte("timestamp", f"{today}T00:00:00+00:00")
        .lte("timestamp", f"{today}T23:59:59+00:00")
        .maybe_single()
        .execute()
    )

    record: dict[str, Any] = {
        "total_value": round(total_value, 2),
        "benchmark_value": round(benchmark_value, 2) if benchmark_value is not None else None,
    }

    if existing.data:
        response = (
            client.table("equity_history")
            .update(record)
            .eq("id", existing.data["id"])
            .execute()
        )
    else:
        response = client.table("equity_history").insert(record).execute()

    row = response.data[0]
    logger.info(
        "Equity snapshot saved: total=$%.2f benchmark=$%.2f",
        total_value,
        benchmark_value or 0,
    )
    return row


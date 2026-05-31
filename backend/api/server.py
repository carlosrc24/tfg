"""
api/server.py – FastAPI server exposing the Quant Lab HTTP interface.

Endpoints
---------
POST /api/backtest/run    — Launch a parameterised backtest in a background thread.
GET  /api/backtest/status/{run_id} — Poll run state, progress, and terminal logs.

Log streaming
-------------
A custom logging.Handler intercepts all log records emitted during the backtest
and accumulates them in memory. A daemon thread flushes the full accumulated text
to the backtest_runs.terminal_logs column every 2 seconds so the frontend can
subscribe via Supabase Realtime.
"""
from __future__ import annotations

import logging
import re
import sys
import threading
import time
import uuid
from datetime import date, timedelta
from pathlib import Path
from typing import Optional

from fastapi import FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel, Field, field_validator

# ── Path bootstrap so imports from backend/ work ──────────────────────────────
BACKEND_DIR = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(BACKEND_DIR))

from db.supabase_client import get_client

# ── ANSI escape-code stripper (Rich emits these; we store plain text) ─────────
_ANSI_RE = re.compile(r"\x1b\[[0-9;]*[mGKHF]")


def _strip_ansi(text: str) -> str:
    return _ANSI_RE.sub("", text)


# ── Custom log handler that captures records and flushes to Supabase ──────────

class _DBLogHandler(logging.Handler):
    """Captures log records emitted during a backtest and streams them to DB."""

    def __init__(self, run_id: str) -> None:
        super().__init__()
        self.run_id = run_id
        self._lines: list[str] = []
        self._lock = threading.Lock()
        self._closed = False
        self._flush_thread = threading.Thread(target=self._flush_loop, daemon=True)
        self._flush_thread.start()

    def emit(self, record: logging.LogRecord) -> None:
        try:
            msg = _strip_ansi(self.format(record))
            with self._lock:
                self._lines.append(msg + "\n")
        except Exception:
            pass

    def _flush_loop(self) -> None:
        while not self._closed:
            time.sleep(1)
            self._flush_to_db()

    def _flush_to_db(self) -> None:
        with self._lock:
            if not self._lines:
                return
            full_text = "".join(self._lines)
        try:
            get_client().table("backtest_runs").update(
                {"terminal_logs": full_text}
            ).eq("id", self.run_id).execute()
        except Exception:
            pass

    def close(self) -> None:
        self._closed = True
        self._flush_to_db()
        super().close()


# ── Pydantic payload model ─────────────────────────────────────────────────────

class BacktestPayload(BaseModel):
    start_date: str = "2023-01-01"
    end_date: Optional[str] = None
    initial_capital: float = Field(100_000.0, ge=5_000, le=150_000)
    atr_multiplier: float = Field(2.5, ge=1.5, le=5.0)
    trend_sma: int = Field(50)
    min_holding_days: int = Field(3, ge=1, le=10)
    confirmation_days: int = Field(2, ge=1, le=5)
    alpha_factor: float = Field(1.0, ge=0.5, le=1.5)
    beta_factor: float = Field(1.0, ge=0.0, le=2.0)

    @field_validator("trend_sma")
    @classmethod
    def validate_trend_sma(cls, v: int) -> int:
        if v not in (20, 50, 100, 200):
            raise ValueError("trend_sma must be one of 20, 50, 100, 200")
        return v

    @field_validator("start_date")
    @classmethod
    def validate_start_date(cls, v: str) -> str:
        date.fromisoformat(v)  # raises ValueError on bad format
        return v

    @field_validator("end_date")
    @classmethod
    def validate_end_date(cls, v: Optional[str]) -> Optional[str]:
        if v is None:
            return v
        parsed = date.fromisoformat(v)
        # Alpaca's free tier blocks SIP data for the current trading day (403).
        # Cap end_date to yesterday so the StockBarsRequest never includes today.
        latest_allowed = date.today() - timedelta(days=1)
        if parsed >= date.today():
            parsed = latest_allowed
        return parsed.isoformat()


# ── Background task runner ────────────────────────────────────────────────────

def _run_backtest_task(run_id: str, params: BacktestPayload) -> None:
    """Executed in a daemon thread; runs the full backtest pipeline."""
    client = get_client()
    handler = _DBLogHandler(run_id)
    handler.setFormatter(
        logging.Formatter("[%(asctime)s] %(levelname)-8s %(name)s — %(message)s",
                          datefmt="%H:%M:%S")
    )
    root = logging.getLogger()
    root.addHandler(handler)

    try:
        client.table("backtest_runs").update({"status": "running"}).eq("id", run_id).execute()

        # Import lazily so module-level Rich logging setup doesn't run at server boot
        from backtest.backtest_engine import run_backtest

        run_backtest(
            start=date.fromisoformat(params.start_date),
            end=date.fromisoformat(params.end_date) if params.end_date else None,
            initial_capital=params.initial_capital,
            atr_multiplier=params.atr_multiplier,
            trend_sma=params.trend_sma,
            min_holding_days=params.min_holding_days,
            confirmation_days=params.confirmation_days,
            alpha_factor=params.alpha_factor,
            beta_factor=params.beta_factor,
            run_id=run_id,
            show_progress=False,
            log_flush_fn=handler._flush_to_db,
        )
        client.table("backtest_runs").update(
            {"status": "completed", "progress_pct": 100}
        ).eq("id", run_id).execute()

    except Exception as exc:
        logging.getLogger("api.server").exception("Backtest %s failed: %s", run_id, exc)
        try:
            client.table("backtest_runs").update({"status": "failed"}).eq("id", run_id).execute()
        except Exception:
            pass
    finally:
        handler.close()
        root.removeHandler(handler)


# ── FastAPI app ───────────────────────────────────────────────────────────────

app = FastAPI(title="TFG Quant Lab API", version="1.0.0")

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_methods=["*"],
    allow_headers=["*"],
)


@app.post("/api/backtest/run")
def start_backtest(params: BacktestPayload) -> dict:
    run_id = str(uuid.uuid4())
    get_client().table("backtest_runs").insert({
        "id": run_id,
        "status": "queued",
        "progress_pct": 0,
        "terminal_logs": "",
        "parameters": params.model_dump(),
    }).execute()

    thread = threading.Thread(
        target=_run_backtest_task, args=(run_id, params), daemon=True
    )
    thread.start()
    return {"run_id": run_id, "status": "queued"}


@app.get("/api/backtest/status/{run_id}")
def get_status(run_id: str) -> dict:
    result = (
        get_client()
        .table("backtest_runs")
        .select("id, status, progress_pct, terminal_logs, parameters, created_at")
        .eq("id", run_id)
        .maybe_single()
        .execute()
    )
    if not result.data:
        raise HTTPException(status_code=404, detail="Run not found")
    return result.data


@app.get("/api/health")
def health() -> dict:
    return {"status": "ok"}

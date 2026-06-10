"""
backtest/virtual_wallet.py – In-memory paper broker for backtesting (V7).

Long-Only strategy. No short selling.
The wallet state for any asset alternates strictly between LONG and CASH.

Dynamic capital limit (from initial_balance):
max_long_usd = initial_balance × max_allocation_pct   (default 20%)

Exit rules (in evaluation order inside check_trailing_stop):
  1. Take-Profit  @ price ≥ entry × (1 + take_profit_pct)  → sell 50% (fires once)
  2. Trailing Stop Tier-1 @ price ≤ highest × 0.85          → sell 70%
  3. Trailing Stop Tier-2 @ price ≤ highest × 0.80          → sell remaining 30%

All thresholds come from the engine and reflect UI slider values.
"""
from __future__ import annotations

import logging
import datetime
from dataclasses import dataclass
from typing import Optional

logger = logging.getLogger(__name__)

# ── Order-sizing constants ─────────────────────────────────────────────────────
# MIN/MAX order USD are now dynamic instance attributes (10%/50% of max_long_usd)
# so they scale with initial_capital × max_allocation_pct.
BUY_THRESHOLD:      float = 0.60
SELL_THRESHOLD:     float = 0.40
PARTIAL_EXIT_LOWER: float = 0.35

# ── Percentage trailing stop thresholds (long only) ───────────────────────────
LONG_TIER1_FACTOR: float = 0.85   # sell 70%  when price ≤ highest × 0.85
LONG_TIER2_FACTOR: float = 0.80   # sell 30%  when price ≤ highest × 0.80

# ── Cash yield ─────────────────────────────────────────────────────────────────
# Matches the risk-free rate already used in Sharpe/Sortino calculations.
ANNUAL_CASH_RATE:      float = 0.04
TRADING_DAYS_PER_YEAR: int   = 252
DAILY_CASH_RATE:       float = ANNUAL_CASH_RATE / TRADING_DAYS_PER_YEAR


@dataclass
class Position:
    side: str          # always "long" in V7
    qty: float
    entry_price: float


@dataclass
class TradeRecord:
    """Returned by wallet methods; ready to insert into Supabase."""
    action: str
    price: float
    quantity: float
    profit_loss: Optional[float] = None


class VirtualWallet:
    """
    Simulated brokerage account – V7 (Long-Only).

    Parameters (all UI-slider driven, no hidden overrides):
        initial_balance  : Starting capital in USD.
        atr_multiplier   : Accepted for API compatibility; stops are percentage-based.
        beta_factor      : Scales order size by the asset's CAPM beta.
        min_holding_days : Days a position must be held before any exit fires.
        buy_threshold    : Min model probability for a long (alpha-scaled).
    """

    def __init__(
        self,
        initial_balance: float = 100_000.0,
        atr_multiplier: float = 2.5,
        beta_factor: float = 1.0,
        min_holding_days: int = 3,
        buy_threshold: float = BUY_THRESHOLD,
        max_allocation_pct: float = 0.20,
        take_profit_pct: float = 0.0,
    ) -> None:
        self.balance: float = initial_balance
        self.initial_balance: float = initial_balance
        self.atr_multiplier: float = atr_multiplier   # kept for API compatibility
        self.beta_factor: float = beta_factor
        self.min_holding_days: int = min_holding_days
        self.buy_threshold: float = buy_threshold
        self.max_allocation_pct: float = max_allocation_pct
        self.take_profit_pct: float = take_profit_pct

        # Dynamic long cap — max_allocation_pct of initial capital
        self.max_long_usd: float = round(initial_balance * max_allocation_pct, 2)

        # Order sizing: 10% / 50% of the position cap so orders scale with capital.
        # Example: $100k capital, 20% cap → max_long_usd=$20k → min=$2k, max=$10k.
        self.min_order_usd: float = round(self.max_long_usd * 0.10, 2)
        self.max_order_usd: float = round(self.max_long_usd * 0.50, 2)

        self.positions: dict[str, Position] = {}

        # Trailing stop & take-profit state — reset on full close
        self.highest_price_seen:  dict[str, float] = {}   # long peak
        self.stop_tier_triggered: dict[str, bool]  = {}   # True after Tier-1 fires
        self.take_profit_fired:   dict[str, bool]  = {}   # True after take-profit fires

        # Time-lock state
        self.last_order_date: dict[str, datetime.date] = {}

        # Cumulative interest earned (visible to the engine for summary logging)
        self.total_interest_accrued: float = 0.0

    # ── Cash interest accrual ──────────────────────────────────────────────────

    def accrue_daily_cash_interest(self) -> float:
        """
        Apply one trading-day's worth of 4% p.a. interest to idle cash.
        Called once per simulated day in the engine loop, before the equity snapshot.
        Returns the interest amount added (also accumulated in total_interest_accrued).
        """
        interest = self.balance * DAILY_CASH_RATE
        self.balance += interest
        self.total_interest_accrued += interest
        return interest

    # ── Portfolio valuation ────────────────────────────────────────────────────

    def portfolio_value(self, current_prices: dict[str, float]) -> float:
        """Total = cash + mark-to-market of all long positions."""
        pos_value = sum(
            pos.qty * current_prices.get(symbol, pos.entry_price)
            for symbol, pos in self.positions.items()
        )
        return self.balance + pos_value

    def position_market_value(self, symbol: str, price: float) -> float:
        pos = self.positions.get(symbol)
        if pos is None:
            return 0.0
        return pos.qty * price

    def has_any_open_position(self) -> bool:
        return len(self.positions) > 0

    def is_fully_in_cash(self) -> bool:
        return len(self.positions) == 0

    # ── Trailing stop state helpers ────────────────────────────────────────────

    def update_highest_price(self, symbol: str, close_price: float) -> None:
        """Advance the long high-water mark each day."""
        pos = self.positions.get(symbol)
        if pos is None or pos.side != "long":
            return
        if close_price > self.highest_price_seen.get(symbol, 0.0):
            self.highest_price_seen[symbol] = close_price

    def update_lowest_price(self, symbol: str, close_price: float) -> None:
        """No-op in V7 (long-only). Kept for call-site compatibility."""
        pass

    def _clear_trailing_state(self, symbol: str) -> None:
        self.highest_price_seen.pop(symbol, None)
        self.stop_tier_triggered.pop(symbol, None)
        self.take_profit_fired.pop(symbol, None)
        self.last_order_date.pop(symbol, None)

    # ── Trade execution primitives ─────────────────────────────────────────────

    def buy(self, symbol: str, qty: float, price: float) -> TradeRecord:
        cost = qty * price
        if cost > self.balance + 1e-9:
            raise ValueError(
                f"Insufficient balance to buy {symbol}: "
                f"need ${cost:.2f}, have ${self.balance:.2f}"
            )
        self.balance -= cost
        if symbol in self.positions and self.positions[symbol].side == "long":
            old = self.positions[symbol]
            total_qty = old.qty + qty
            avg_price = (old.qty * old.entry_price + qty * price) / total_qty
            self.positions[symbol] = Position("long", total_qty, avg_price)
        else:
            self.positions[symbol] = Position("long", qty, price)
            self.highest_price_seen[symbol] = price
            self.stop_tier_triggered[symbol] = False
        logger.debug("BUY  %s  qty=%.4f  price=%.2f  balance=%.2f", symbol, qty, price, self.balance)
        return TradeRecord(action="BUY", price=price, quantity=qty)

    def sell(self, symbol: str, qty: float, price: float, label: str = "SELL") -> TradeRecord:
        pos = self.positions.get(symbol)
        if pos is None or pos.side != "long":
            logger.warning("sell() called but no long position in %s — skipping.", symbol)
            return TradeRecord(action=label, price=price, quantity=0.0, profit_loss=0.0)
        qty = min(qty, pos.qty)
        pnl = (price - pos.entry_price) * qty
        self.balance += qty * price
        if abs(pos.qty - qty) < 1e-4:
            del self.positions[symbol]
            self._clear_trailing_state(symbol)
        else:
            self.positions[symbol].qty -= qty
        logger.debug("%s  %s  qty=%.4f  price=%.2f  pnl=%.2f", label, symbol, qty, price, pnl)
        return TradeRecord(action=label, price=price, quantity=qty, profit_loss=pnl)

    # ── Decision logic ─────────────────────────────────────────────────────────

    def check_trailing_stop(
        self,
        symbol: str,
        close_price: float,
        execution_price: float,
        atr: float,
        volatility: float,
        current_date: datetime.date,
    ) -> list[TradeRecord]:
        """
        Tiered percentage trailing stop for long positions only.

        Tier-1: close ≤ highest × 0.85  →  sell 70% of position
        Tier-2: close ≤ highest × 0.80  →  sell remaining 30%

        The time-lock (min_holding_days) applies to all tiers uniformly.
        `atr` and `volatility` are accepted for call-site compatibility.
        """
        pos = self.positions.get(symbol)
        if pos is None or pos.side != "long":
            return []

        # Uniform time-lock
        entry_date = self.last_order_date.get(symbol)
        if entry_date is not None:
            days_held = (current_date - entry_date).days
            if days_held < self.min_holding_days:
                logger.debug(
                    "[%s] Trailing stop blocked by %d-day time-lock (%d days held).",
                    symbol, self.min_holding_days, days_held,
                )
                return []

        records: list[TradeRecord] = []

        # ── Take-profit (fires once per position lifecycle) ───────────────────
        if self.take_profit_pct > 0 and not self.take_profit_fired.get(symbol, False):
            tp_level = pos.entry_price * (1.0 + self.take_profit_pct)
            if close_price >= tp_level:
                qty_50 = round(pos.qty * 0.50, 4)
                if qty_50 < 0.01:
                    qty_50 = pos.qty
                logger.info(
                    "[%s] TAKE-PROFIT: close=%.2f ≥ entry×%.2f=%.2f "
                    "— selling 50%% (%.4f shares)",
                    symbol, close_price, 1.0 + self.take_profit_pct, tp_level, qty_50,
                )
                records.append(self.sell(symbol, qty_50, execution_price, "SELL"))
                if symbol in self.positions:
                    self.take_profit_fired[symbol] = True

        # ── Percentage trailing stop ───────────────────────────────────────────
        tier1_already = self.stop_tier_triggered.get(symbol, False)
        peak = self.highest_price_seen.get(symbol, pos.entry_price)
        tier1_level = peak * LONG_TIER1_FACTOR    # peak × 0.85
        tier2_level = peak * LONG_TIER2_FACTOR    # peak × 0.80

        if not tier1_already:
            if close_price <= tier1_level:
                qty_70 = round(pos.qty * 0.70, 4)
                if qty_70 < 0.01:
                    qty_70 = pos.qty
                logger.info(
                    "[%s] LONG Stop TIER-1: close=%.2f ≤ peak×0.85=%.2f "
                    "— selling 70%% (%.4f shares)",
                    symbol, close_price, tier1_level, qty_70,
                )
                records.append(self.sell(symbol, qty_70, execution_price, "SELL"))
                if symbol in self.positions:
                    self.stop_tier_triggered[symbol] = True
        else:
            if close_price <= tier2_level:
                remaining = self.positions.get(symbol)
                if remaining is not None:
                    logger.info(
                        "[%s] LONG Stop TIER-2: close=%.2f ≤ peak×0.80=%.2f "
                        "— selling remaining 30%% (%.4f shares)",
                        symbol, close_price, tier2_level, remaining.qty,
                    )
                    records.append(self.sell(symbol, remaining.qty, execution_price, "SELL"))

        return records

    def execute_signal(
        self,
        symbol: str,
        prediction_prob: float,
        execution_price: float,
        current_date: datetime.date,
        *,
        trend_bullish: bool = True,
        macro_uptrend: bool = False,
        atr: float = 0.0,
        volatility: float = 0.20,
        current_price: float | None = None,
        close_price: float | None = None,
        hysteresis_bypassed: bool = False,
        beta: float = 1.0,
    ) -> list[TradeRecord]:
        """
        Long-only decision tree. The wallet alternates strictly between LONG and CASH.

        BUY  : prob ≥ buy_threshold AND trend_bullish AND position not at cap.
        HOLD : prob in neutral zone, or time-locked, or macro_uptrend blocks exit.
        SELL : prob bearish zone AND not time-locked AND not macro_uptrend.

        Call check_trailing_stop() BEFORE this method in the engine loop.
        """
        records: list[TradeRecord] = []
        pos = self.positions.get(symbol)
        is_long = pos is not None and pos.side == "long"

        if hysteresis_bypassed:
            logger.info("[%s] Hysteresis BYPASSED (prob=%.3f)", symbol, prediction_prob)

        # Time-lock
        entry_date = self.last_order_date.get(symbol)
        time_locked = (
            entry_date is not None
            and (current_date - entry_date).days < self.min_holding_days
        )

        def _order_usd(prob: float) -> float:
            t = (prob - self.buy_threshold) / (1.0 - self.buy_threshold)
            base = round(max(self.min_order_usd, min(self.max_order_usd,
                             self.min_order_usd + t * (self.max_order_usd - self.min_order_usd))), 2)
            beta_scale = abs(beta) * self.beta_factor if self.beta_factor > 0 else 1.0
            return round(min(base * beta_scale, self.max_order_usd), 2)

        # ── LONG conviction ────────────────────────────────────────────────────
        if prediction_prob >= self.buy_threshold:
            if not trend_bullish:
                return records  # price below SMA-100: suppress buy
            current_val = (pos.qty * execution_price) if is_long and pos else 0.0
            if current_val >= self.max_long_usd:
                return records  # position already at cap
            order_usd = _order_usd(prediction_prob)
            order_usd = min(order_usd, self.max_long_usd - current_val, self.balance)
            qty = round(order_usd / execution_price, 4)
            if qty >= 0.01:
                records.append(self.buy(symbol, qty, execution_price))
                self.last_order_date[symbol] = current_date
            return records

        # ── NEUTRAL: hold existing long or stay in cash ────────────────────────
        if SELL_THRESHOLD < prediction_prob < self.buy_threshold:
            return records

        # ── BEARISH – partial exit ─────────────────────────────────────────────
        if PARTIAL_EXIT_LOWER <= prediction_prob <= SELL_THRESHOLD:
            if macro_uptrend or time_locked:
                return records  # macro filter or time-lock blocks exit
            if is_long:
                partial = round(pos.qty * 0.50, 4)
                if partial < 0.01:
                    partial = pos.qty
                records.append(self.sell(symbol, partial, execution_price, "SELL"))
            return records

        # ── BEARISH – full exit ────────────────────────────────────────────────
        if prediction_prob < PARTIAL_EXIT_LOWER:
            if is_long:
                records.append(self.sell(symbol, pos.qty, execution_price, "SELL"))
            return records

        return records

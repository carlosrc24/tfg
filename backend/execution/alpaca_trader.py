"""
execution/alpaca_trader.py – Alpaca Paper Trading execution layer.

Handles:
  • Fetching current portfolio / positions
  • Dynamic position sizing based on model confidence
  • Placing market BUY (LONG) / SELL SHORT orders
  • Partial and full exits with P&L tracking
  • Buying power safety check before every order
  • Recording all trades to Supabase
"""
from __future__ import annotations

import logging
from typing import Any

from alpaca.trading.client import TradingClient
from alpaca.trading.requests import MarketOrderRequest, GetOrdersRequest
from alpaca.trading.enums import OrderSide, TimeInForce, PositionSide, QueryOrderStatus

from config import ALPACA_API_KEY, ALPACA_SECRET_KEY, BUY_THRESHOLD, SELL_THRESHOLD
from db.supabase_client import insert_trade

logger = logging.getLogger(__name__)

# ── Position-sizing parameters ────────────────────────────────────────────────
MIN_ORDER_USD: float = 500.0    # minimum bet (at threshold boundary)
MAX_ORDER_USD: float = 3000.0   # maximum bet (at maximum conviction)

# Partial-exit probability boundaries
PARTIAL_EXIT_UPPER: float = 0.40   # prob between 0.30–0.40 → sell 50%
PARTIAL_EXIT_LOWER: float = 0.30   # prob < 0.30 → sell 100%

# ── Client singleton ───────────────────────────────────────────────────────────
_trading_client: TradingClient | None = None


def _get_client() -> TradingClient:
    global _trading_client
    if _trading_client is None:
        _trading_client = TradingClient(
            api_key=ALPACA_API_KEY,
            secret_key=ALPACA_SECRET_KEY,
            paper=True,
        )
        logger.info("Alpaca TradingClient initialised (Paper Trading).")
    return _trading_client


# ── Account helpers ────────────────────────────────────────────────────────────

def get_account() -> Any:
    return _get_client().get_account()


def get_positions() -> dict[str, Any]:
    """Return dict symbol → position object."""
    positions = _get_client().get_all_positions()
    return {p.symbol: p for p in positions}


def get_buying_power() -> float:
    account = get_account()
    return float(account.buying_power)


# ── Dynamic position sizing ────────────────────────────────────────────────────

def calculate_order_size(probability: float) -> float:
    """
    Return the order value in USD, scaled linearly by model confidence.

    Long  (prob ≥ BUY_THRESHOLD):
        prob=0.60 → $500   |   prob=1.00 → $3000

    Short (prob ≤ SELL_THRESHOLD):
        prob=0.40 → $500   |   prob=0.00 → $3000

    Returns a value in [MIN_ORDER_USD, MAX_ORDER_USD].
    """
    if probability >= BUY_THRESHOLD:
        # Scale: [BUY_THRESHOLD, 1.0] → [MIN, MAX]
        t = (probability - BUY_THRESHOLD) / (1.0 - BUY_THRESHOLD)
    else:
        # Scale: [SELL_THRESHOLD, 0.0] → [MIN, MAX]  (inverted)
        t = (SELL_THRESHOLD - probability) / SELL_THRESHOLD

    size = MIN_ORDER_USD + t * (MAX_ORDER_USD - MIN_ORDER_USD)
    return round(max(MIN_ORDER_USD, min(MAX_ORDER_USD, size)), 2)


# ── Order helpers ──────────────────────────────────────────────────────────────

def _place_order(symbol: str, qty: float, side: OrderSide) -> Any:
    """Place a market order and return the Alpaca order object."""
    client = _get_client()
    request = MarketOrderRequest(
        symbol=symbol,
        qty=qty,
        side=side,
        time_in_force=TimeInForce.DAY,
    )
    order = client.submit_order(request)
    logger.info(
        "Order submitted: %s %s x%.2f → id=%s",
        side.value, symbol, qty, order.id,
    )
    return order


def _check_buying_power(required_usd: float, symbol: str) -> bool:
    """Return True if there is enough buying power to place the order."""
    bp = get_buying_power()
    if bp < required_usd:
        logger.warning(
            "%s: Insufficient buying power (have $%.2f, need $%.2f). Skipping.",
            symbol, bp, required_usd,
        )
        return False
    return True


def _cancel_open_orders(symbol: str) -> None:
    """Cancel all open (pending) orders for a specific symbol."""
    client = _get_client()
    try:
        req = GetOrdersRequest(status=QueryOrderStatus.OPEN, symbols=[symbol])
        open_orders = client.get_orders(req)
        for order in open_orders:
            client.cancel_order_by_id(order.id)
            logger.info("%s: Cancelled pending order %s", symbol, order.id)
    except Exception as e:
        logger.warning("%s: Failed to cancel open orders: %s", symbol, e)


def buy_long(symbol: str, etf_id: str, qty: float, price: float, order_usd: float) -> None:
    """Place a LONG BUY market order and record it in Supabase."""
    _place_order(symbol, qty, OrderSide.BUY)
    insert_trade({"etf_id": etf_id, "action": "BUY", "price": price, "quantity": qty})
    logger.info("LONG BUY: %s @ %.4f  qty=%.2f  ($%.2f)", symbol, price, qty, order_usd)


def sell_long(
    symbol: str,
    etf_id: str,
    qty: float,
    price: float,
    entry_price: float | None = None,
    label: str = "SELL",
) -> None:
    """Close (fully or partially) a LONG position and record P&L."""
    _place_order(symbol, qty, OrderSide.SELL)
    pnl = (price - entry_price) * qty if entry_price else None
    insert_trade({
        "etf_id": etf_id,
        "action": label,
        "price": price,
        "quantity": qty,
        "profit_loss": pnl,
    })
    logger.info("%s: %s @ %.4f  qty=%.2f  P&L=$%.2f", label, symbol, price, qty, pnl or 0)


def sell_short(symbol: str, etf_id: str, qty: float, price: float, order_usd: float) -> None:
    """Open a SHORT position (sell without owning) and record in Supabase.

    NOTE: Alpaca does NOT allow fractional short orders (error 42210000).
    qty is always floored to an integer here as a safety net.
    """
    qty = int(qty)  # Alpaca: fractional orders cannot be sold short
    if qty < 1:
        logger.warning("SHORT qty rounded to 0 for %s – skipping.", symbol)
        return
    _place_order(symbol, qty, OrderSide.SELL)
    insert_trade({"etf_id": etf_id, "action": "SHORT", "price": price, "quantity": qty})
    logger.info("SHORT SELL: %s @ %.4f  qty=%d  ($%.2f)", symbol, price, qty, order_usd)


def cover_short(
    symbol: str,
    etf_id: str,
    qty: float,
    price: float,
    entry_price: float | None = None,
) -> None:
    """Close a SHORT position (buy to cover) and record P&L."""
    _place_order(symbol, qty, OrderSide.BUY)
    pnl = (entry_price - price) * qty if entry_price else None   # profit when price drops
    insert_trade({
        "etf_id": etf_id,
        "action": "COVER",
        "price": price,
        "quantity": qty,
        "profit_loss": pnl,
    })
    logger.info("COVER SHORT: %s @ %.4f  qty=%.2f  P&L=$%.2f", symbol, price, qty, pnl or 0)


# ── Main decision logic ────────────────────────────────────────────────────────

def execute_signal(
    symbol: str,
    etf_id: str,
    prediction_prob: float,
    current_price: float,
) -> str:
    """
    Execute the appropriate trade based on the model's probability.

    Decision tree:
    ─────────────────────────────────────────────────────────────────
    prob ≥ 0.60   → LONG:  open new long position (dynamic size)
    0.40 < prob < 0.60  → HOLD (no change, or cover short if open)
    0.30 ≤ prob ≤ 0.40  → PARTIAL EXIT: sell 50% of long, or open short
    prob < 0.30   → FULL EXIT: sell 100% of long, or open/add short
    ─────────────────────────────────────────────────────────────────
    Returns: 'BUY', 'SELL_PARTIAL', 'SELL_FULL', 'SHORT', 'COVER', 'HOLD'
    """
    # Cancel any pending orders from previous runs first
    _cancel_open_orders(symbol)

    positions = get_positions()
    position = positions.get(symbol)

    # Determine current position type
    is_long  = position is not None and float(position.qty) > 0
    is_short = position is not None and float(position.qty) < 0

    # ── 1. HIGH conviction LONG ──────────────────────────────────────────────
    if prediction_prob >= BUY_THRESHOLD:
        # If we have a short, close it first (cover)
        if is_short:
            qty = abs(float(position.qty))
            entry_price = float(position.avg_entry_price)
            cover_short(symbol, etf_id, qty, current_price, entry_price)
            position = None
            is_long = False

        # Open long or add to existing long
        current_position_value = float(position.market_value) if is_long else 0.0
        MAX_POSITION_USD = 20000.0

        if current_position_value >= MAX_POSITION_USD:
            logger.info("%s: Max position limit ($%.2f) reached. Holding.", symbol, MAX_POSITION_USD)
            return "HOLD"

        order_usd = calculate_order_size(prediction_prob)

        # Cap order size if it would exceed MAX_POSITION_USD
        if current_position_value + order_usd > MAX_POSITION_USD:
            order_usd = MAX_POSITION_USD - current_position_value

        if not _check_buying_power(order_usd, symbol):
            return "HOLD"
        qty = round(order_usd / current_price, 2)
        if qty < 0.01:
            logger.warning("Position size too small for %s. Skipping.", symbol)
            return "HOLD"
        buy_long(symbol, etf_id, qty, current_price, order_usd)
        return "BUY"

    # ── 2. NEUTRAL zone ─────────────────────────────────────────────────────
    if SELL_THRESHOLD < prediction_prob < BUY_THRESHOLD:
        # Cover any short position since signal is no longer bearish
        if is_short:
            qty = abs(float(position.qty))
            entry_price = float(position.avg_entry_price)
            cover_short(symbol, etf_id, qty, current_price, entry_price)
            return "COVER"
        logger.info(
            "%s: prob=%.4f → HOLD (BUY≥%.2f SELL≤%.2f)",
            symbol, prediction_prob, BUY_THRESHOLD, SELL_THRESHOLD,
        )
        return "HOLD"

    # ── 3. BEARISH zone (prob ≤ SELL_THRESHOLD) ──────────────────────────────

    # 3a. PARTIAL EXIT: 0.30 ≤ prob ≤ 0.40
    if PARTIAL_EXIT_LOWER <= prediction_prob <= SELL_THRESHOLD:
        if is_long:
            full_qty = float(position.qty)
            partial_qty = round(full_qty * 0.50, 2)
            if partial_qty < 0.01:
                partial_qty = full_qty   # too small to split, just close
            entry_price = float(position.avg_entry_price)
            sell_long(symbol, etf_id, partial_qty, current_price, entry_price, label="SELL_PARTIAL")
            return "SELL_PARTIAL"

        # No long position → open a short
        order_usd = calculate_order_size(prediction_prob)
        if not _check_buying_power(order_usd, symbol):
            return "HOLD"
        qty = int(order_usd / current_price)  # int: Alpaca forbids fractional shorts
        if qty < 1:
            logger.warning("SHORT qty < 1 for %s (price=%.2f, usd=%.2f). Skipping.", symbol, current_price, order_usd)
            return "HOLD"
        sell_short(symbol, etf_id, qty, current_price, order_usd)
        return "SHORT"

    # 3b. FULL EXIT: prob < 0.30
    if prediction_prob < PARTIAL_EXIT_LOWER:
        if is_long:
            qty = float(position.qty)
            entry_price = float(position.avg_entry_price)
            sell_long(symbol, etf_id, qty, current_price, entry_price, label="SELL_FULL")
            return "SELL_FULL"

        # High conviction bearish → open or add to short
        current_position_value = abs(float(position.market_value)) if is_short else 0.0
        MAX_POSITION_USD = 10000.0

        if current_position_value >= MAX_POSITION_USD:
            logger.info("%s: Max short position limit ($%.2f) reached. Holding.", symbol, MAX_POSITION_USD)
            return "HOLD"

        order_usd = calculate_order_size(prediction_prob)

        # Cap order size if it would exceed MAX_POSITION_USD
        if current_position_value + order_usd > MAX_POSITION_USD:
            order_usd = MAX_POSITION_USD - current_position_value

        if not _check_buying_power(order_usd, symbol):
            return "HOLD"
        qty = int(order_usd / current_price)  # int: Alpaca forbids fractional shorts
        if qty < 1:
            logger.warning("SHORT qty < 1 for %s (price=%.2f, usd=%.2f). Skipping.", symbol, current_price, order_usd)
            return "HOLD"
        sell_short(symbol, etf_id, qty, current_price, order_usd)
        return "SHORT"

    return "HOLD"

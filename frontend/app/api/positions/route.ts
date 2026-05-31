import { NextResponse } from "next/server";

const ALPACA_API_KEY = process.env.API_KEY_ALPACA ?? "";
const ALPACA_SECRET_KEY = process.env.SECRET_API_KEY_ALPACA ?? "";
const ALPACA_BASE = "https://paper-api.alpaca.markets";
const DATA_BASE = "https://data.alpaca.markets";

interface AlpacaPosition {
  symbol: string;
  qty: string;
  side: string;
  avg_entry_price: string;
  current_price: string;
  unrealized_pl: string;
  unrealized_plpc: string;
  market_value: string;
}

async function alpacaFetch(path: string) {
  const res = await fetch(`${ALPACA_BASE}${path}`, {
    headers: {
      "APCA-API-KEY-ID": ALPACA_API_KEY,
      "APCA-API-SECRET-KEY": ALPACA_SECRET_KEY,
    },
    cache: "no-store",
  });
  if (!res.ok) throw new Error(`Alpaca ${path} → ${res.status}`);
  return res.json();
}

export async function GET() {
  try {
    const [positions, account] = await Promise.all([
      alpacaFetch("/v2/positions"),
      alpacaFetch("/v2/account"),
    ]);

    const mapped = (positions as AlpacaPosition[]).map((p) => ({
      symbol: p.symbol,
      side: p.side,                                         // "long" | "short"
      qty: parseFloat(p.qty),
      avg_entry_price: parseFloat(p.avg_entry_price),
      current_price: parseFloat(p.current_price),
      unrealized_pl: parseFloat(p.unrealized_pl),
      unrealized_plpc: parseFloat(p.unrealized_plpc) * 100, // → percentage
      market_value: parseFloat(p.market_value),
    }));

    return NextResponse.json({
      positions: mapped,
      portfolio_value: parseFloat(account.portfolio_value),
      buying_power: parseFloat(account.buying_power),
      cash: parseFloat(account.cash),
    });
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : "Unknown error";
    return NextResponse.json({ error: message, positions: [] }, { status: 200 });
  }
}

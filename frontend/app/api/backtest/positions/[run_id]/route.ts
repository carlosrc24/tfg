import { NextResponse } from "next/server";
import { createClient } from "@supabase/supabase-js";

// Service role key — bypasses RLS, server-only
const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL ?? "",
  process.env.SUPABASE_KEY ?? process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ?? ""
);

interface TradeRow {
  id: string;
  etf_id: string;
  timestamp: string;
  action: string;
  price: number;
  quantity: number;
  profit_loss: number | null;
}

export async function GET(
  _request: Request,
  { params }: { params: { run_id: string } }
) {
  const { run_id } = params;

  try {
    const [
      { data: etfs, error: etfsError },
      { data: tradeData, error: tradesError },
      { data: lastEquity },
      { data: runData },
    ] = await Promise.all([
      supabase.from("etfs").select("id, symbol"),
      supabase
        .from("trades")
        .select("id, etf_id, timestamp, action, price, quantity, profit_loss")
        .eq("run_id", run_id)
        .order("timestamp", { ascending: true })
        .limit(5000),
      supabase
        .from("equity_history")
        .select("total_value")
        .eq("run_id", run_id)
        .eq("is_backtest", true)
        .order("timestamp", { ascending: false })
        .limit(1)
        .maybeSingle(),
      supabase
        .from("backtest_runs")
        .select("parameters")
        .eq("id", run_id)
        .maybeSingle(),
    ]);

    if (etfsError) throw new Error(`etfs: ${etfsError.message}`);
    if (tradesError) throw new Error(`trades: ${tradesError.message}`);

    // ETF id → symbol map
    const symbolMap: Record<string, string> = {};
    (etfs ?? []).forEach((e: { id: string; symbol: string }) => {
      symbolMap[e.id] = e.symbol;
    });

    const rows: TradeRow[] = tradeData ?? [];

    // ── Compute final open positions ────────────────────────────────────────
    const posQty: Record<string, number> = {};
    const posAvgEntry: Record<string, number> = {};
    let totalBuyCost = 0;
    let totalSellProceeds = 0;

    for (const t of rows) {
      if (t.action === "BUY") {
        const oldQty = posQty[t.etf_id] ?? 0;
        const oldAvg = posAvgEntry[t.etf_id] ?? 0;
        const newQty = oldQty + t.quantity;
        posAvgEntry[t.etf_id] =
          newQty > 0
            ? (oldQty * oldAvg + t.quantity * t.price) / newQty
            : t.price;
        posQty[t.etf_id] = newQty;
        totalBuyCost += t.quantity * t.price;
      } else if (t.action === "SELL") {
        const newQty = (posQty[t.etf_id] ?? 0) - t.quantity;
        if (newQty < 0.001) {
          delete posQty[t.etf_id];
          delete posAvgEntry[t.etf_id];
        } else {
          posQty[t.etf_id] = newQty;
        }
        totalSellProceeds += t.quantity * t.price;
      }
    }

    const initialCapital: number =
      runData?.parameters?.initial_capital ?? 100_000;
    const finalCash = Math.max(
      0,
      initialCapital + totalSellProceeds - totalBuyCost
    );
    const lastTotalValue = lastEquity?.total_value ?? null;
    const totalOpenMarketValue =
      lastTotalValue !== null ? Math.max(0, lastTotalValue - finalCash) : null;

    const openPositions = Object.entries(posQty)
      .filter(([, qty]) => qty > 0.001)
      .map(([etfId, qty]) => ({
        etfId,
        symbol: symbolMap[etfId] ?? "?",
        qty,
        avg_entry_price: posAvgEntry[etfId] ?? 0,
        cost_basis: qty * (posAvgEntry[etfId] ?? 0),
      }))
      .sort((a, b) => b.cost_basis - a.cost_basis);

    // Trade log for display — reversed, capped at 500
    const tradesDesc = [...rows]
      .sort((a, b) => b.timestamp.localeCompare(a.timestamp))
      .slice(0, 500);

    const totalPnL = rows.reduce(
      (sum, t) => sum + (t.profit_loss ?? 0),
      0
    );

    return NextResponse.json({
      openPositions,
      trades: tradesDesc,
      tradeCount: rows.length,
      finalCash,
      totalOpenMarketValue,
      totalPnL,
      symbolMap,
    });
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : "Unknown error";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}

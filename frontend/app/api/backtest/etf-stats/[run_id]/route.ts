import { NextResponse } from "next/server";
import { createClient } from "@supabase/supabase-js";

const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL ?? "",
  process.env.SUPABASE_KEY ?? process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ?? ""
);

interface TradeRow {
  etf_id: string;
  action: string;
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
    ] = await Promise.all([
      supabase.from("etfs").select("id, symbol"),
      supabase
        .from("trades")
        .select("etf_id, action, profit_loss")
        .eq("run_id", run_id)
        .eq("is_backtest", true),
    ]);

    if (etfsError) throw new Error(`etfs: ${etfsError.message}`);
    if (tradesError) throw new Error(`trades: ${tradesError.message}`);

    const symbolMap: Record<string, string> = {};
    (etfs ?? []).forEach((e: { id: string; symbol: string }) => {
      symbolMap[e.id] = e.symbol;
    });

    const agg: Record<string, { buys: number; exits: number; winExits: number; totalPnl: number }> = {};

    for (const t of (tradeData ?? []) as TradeRow[]) {
      if (!agg[t.etf_id]) agg[t.etf_id] = { buys: 0, exits: 0, winExits: 0, totalPnl: 0 };
      if (t.action === "BUY") {
        agg[t.etf_id].buys++;
      } else if (t.action === "SELL") {
        agg[t.etf_id].exits++;
        if (t.profit_loss !== null) {
          agg[t.etf_id].totalPnl += t.profit_loss;
          if (t.profit_loss > 0) agg[t.etf_id].winExits++;
        }
      }
    }

    const etfStats = Object.entries(agg)
      .map(([etfId, s]) => ({
        etfId,
        symbol: symbolMap[etfId] ?? "?",
        buys: s.buys,
        exits: s.exits,
        totalPnl: Math.round(s.totalPnl * 100) / 100,
        winRate: s.exits > 0 ? Math.round((s.winExits / s.exits) * 10000) / 100 : null,
        avgPnlPerExit: s.exits > 0 ? Math.round((s.totalPnl / s.exits) * 100) / 100 : null,
      }))
      .sort((a, b) => b.totalPnl - a.totalPnl);

    return NextResponse.json({ etfStats });
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : "Unknown error";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}

import { supabase, ETF, MarketIntelligence, Trade } from "../lib/supabase";
import DashboardTabs from "./components/DashboardTabs";

// Always render at request time (never statically at build time)
export const dynamic = "force-dynamic";

async function getData() {
  const { data: etfs } = await supabase.from("etfs").select("*").order("symbol");

  const intelligenceByEtf: Record<string, MarketIntelligence[]> = {};
  for (const etf of etfs ?? []) {
    const { data } = await supabase
      .from("market_intelligence")
      .select("*")
      .eq("etf_id", etf.id)
      .order("timestamp", { ascending: false })
      .limit(90);
    intelligenceByEtf[etf.id] = data ?? [];
  }

  // Only live trades for the summary stats
  const { data: trades } = await supabase
    .from("trades")
    .select("*")
    .eq("is_backtest", false)
    .order("timestamp", { ascending: false })
    .limit(100);

  return {
    etfs: (etfs ?? []) as ETF[],
    intelligenceByEtf,
    trades: (trades ?? []) as Trade[],
  };
}

export default async function DashboardPage() {
  const { etfs, intelligenceByEtf, trades } = await getData();

  const etfSymbols: Record<string, string> = {};
  etfs.forEach((e) => { etfSymbols[e.id] = e.symbol; });

  const totalPnL = trades.reduce((s, t) => s + (t.profit_loss ?? 0), 0);
  const activeTrades = trades.filter((t) => t.profit_loss === null).length;

  return (
    <main className="min-h-screen p-6 lg:p-10 max-w-[1600px] mx-auto">
      {/* ── Header ──────────────────────────────────────────────────────────── */}
      <header className="mb-10 fade-in">
        <div className="flex items-center gap-3 mb-2">
          
        </div>
        <h1 className="text-4xl font-extrabold gradient-text leading-tight">
          ETF Trading Dashboard
        </h1>
      </header>

      {/* ── Tab-based dashboard (client component) ────────────────────────── */}
      <DashboardTabs
        etfs={etfs}
        intelligenceByEtf={intelligenceByEtf}
        trades={trades}
        etfSymbols={etfSymbols}
        totalPnL={totalPnL}
        activeTrades={activeTrades}
      />

    </main>
  );
}

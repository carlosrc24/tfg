"use client";

import { useState } from "react";
import BacktestDashboard from "./BacktestDashboard";
import MetricsKpiRow from "./MetricsKpiRow";
import EquityCurveChart from "./EquityCurveChart";
import PositionsTable from "./PositionsTable";
import PortfolioChart from "./PortfolioChart";
import SentimentGauge from "./SentimentGauge";
import TradesTable from "./TradesTable";
import { ETF, MarketIntelligence, Trade } from "../../lib/supabase";

interface Props {
  etfs: ETF[];
  intelligenceByEtf: Record<string, MarketIntelligence[]>;
  trades: Trade[];
  etfSymbols: Record<string, string>;
  totalPnL: number;
  activeTrades: number;
}

type Tab = "live" | "backtest";

export default function DashboardTabs({
  etfs,
  intelligenceByEtf,
  trades,
  etfSymbols,
  totalPnL,
  activeTrades,
}: Props) {
  const [activeTab, setActiveTab] = useState<Tab>("live");
  const allLatest = etfs.map((etf) => ({
    etf,
    latest: (intelligenceByEtf[etf.id] ?? [])[0] ?? null,
  }));

  return (
    <>
      {/* ── Tab Switcher ───────────────────────────────────────────────────── */}
      <div className="flex items-center gap-2 mb-8 p-1 bg-gray-900/70 border border-gray-800 rounded-xl w-fit">
        <button
          id="tab-live"
          onClick={() => setActiveTab("live")}
          className={`flex items-center gap-2 px-5 py-2.5 rounded-lg text-sm font-semibold transition-all duration-200 ${
            activeTab === "live"
              ? "bg-indigo-600 text-white shadow-lg shadow-indigo-900/40"
              : "text-gray-500 hover:text-gray-300"
          }`}
        >
          <span className={`w-2 h-2 rounded-full ${activeTab === "live" ? "bg-emerald-400 animate-pulse" : "bg-gray-600"}`} />
          📡 Live / Paper Trading
        </button>
        <button
          id="tab-backtest"
          onClick={() => setActiveTab("backtest")}
          className={`flex items-center gap-2 px-5 py-2.5 rounded-lg text-sm font-semibold transition-all duration-200 ${
            activeTab === "backtest"
              ? "bg-purple-600 text-white shadow-lg shadow-purple-900/40"
              : "text-gray-500 hover:text-gray-300"
          }`}
        >
          🧪 Backtest Lab
          <span className="text-xs bg-purple-900/60 border border-purple-700/50 text-purple-300 px-1.5 py-0.5 rounded-full">
            2023–2026
          </span>
        </button>
      </div>

      {/* ── LIVE TAB ───────────────────────────────────────────────────────── */}
      {activeTab === "live" && (
        <div>
          {/* KPI Cards */}
          <section className="grid grid-cols-2 md:grid-cols-4 gap-4 mb-8 fade-in">
            <KpiCard label="ETFs Monitorizados" value={String(etfs.length)} icon="📊" />
            <KpiCard
              label="P&L Total"
              value={`${totalPnL >= 0 ? "+" : ""}$${totalPnL.toFixed(2)}`}
              icon={totalPnL >= 0 ? "📈" : "📉"}
              positive={totalPnL >= 0}
            />
            <KpiCard label="Operaciones Abiertas" value={String(activeTrades)} icon="⚡" />
            <KpiCard label="Operaciones Totales" value={String(trades.length)} icon="🔄" />
          </section>

          {/* Performance Metrics */}
          <section className="mb-6">
            <div className="flex items-center gap-2 mb-4">
              <div className="w-2 h-2 rounded-full bg-purple-500" />
              <h2 className="text-sm font-bold text-gray-300 uppercase tracking-widest">
                Métricas de Rendimiento
              </h2>
            </div>
            <MetricsKpiRow />
            <EquityCurveChart />
          </section>

          {/* Live Positions */}
          <section className="mb-10">
            <div className="flex items-center gap-2 mb-4">
              <div className="w-2 h-2 rounded-full bg-emerald-500" />
              <h2 className="text-sm font-bold text-gray-300 uppercase tracking-widest">
                Posiciones en Vivo
              </h2>
            </div>
            <PositionsTable />
          </section>

          {/* ETF Panels */}
          {allLatest.map(({ etf, latest }) => (
            <section key={etf.id} className="mb-10">
              <div className="flex items-center gap-3 mb-4">
                <div className="w-2 h-2 rounded-full bg-indigo-500" />
                <h2 className="text-lg font-bold text-white">{etf.symbol}</h2>
                <span className="text-sm text-gray-500">{etf.name}</span>
              </div>
              <div className="grid grid-cols-1 lg:grid-cols-3 gap-4">
                <div className="lg:col-span-2">
                  <PortfolioChart data={intelligenceByEtf[etf.id] ?? []} symbol={etf.symbol} />
                </div>
                <div>
                  <SentimentGauge
                    sentimentScore={latest?.sentiment_score ?? null}
                    predictionProb={latest?.prediction_prob ?? null}
                  />
                  <div className="glass-card p-4 mt-4 grid grid-cols-2 gap-3 fade-in">
                    {[
                      { label: "RSI (14)", value: latest?.rsi?.toFixed(1) ?? "—" },
                      { label: "ADX (14)", value: latest?.adx?.toFixed(1) ?? "—" },
                      { label: "SMA 50", value: latest?.sma_50 ? `$${latest.sma_50.toFixed(0)}` : "—" },
                      { label: "SMA 200", value: latest?.sma_200 ? `$${latest.sma_200.toFixed(0)}` : "—" },
                      { label: "ATR (14)", value: latest?.atr?.toFixed(2) ?? "—" },
                      { label: "Score NLP", value: latest?.sentiment_score?.toFixed(3) ?? "—" },
                    ].map((ind) => (
                      <div key={ind.label} className="bg-gray-900/50 rounded-lg p-3">
                        <p className="text-xs text-gray-500 mb-1">{ind.label}</p>
                        <p className="text-sm font-semibold text-white font-mono">{ind.value}</p>
                      </div>
                    ))}
                  </div>
                </div>
              </div>
            </section>
          ))}

          {/* Trades Table */}
          <section className="mt-4">
            <TradesTable trades={trades} etfSymbols={etfSymbols} />
          </section>
        </div>
      )}

      {/* ── BACKTEST TAB ───────────────────────────────────────────────────── */}
      {activeTab === "backtest" && (
        <div>
          <BacktestDashboard />
        </div>
      )}
    </>
  );
}

// ── Reusable KPI card ──────────────────────────────────────────────────────
function KpiCard({
  label,
  value,
  icon,
  positive,
}: {
  label: string;
  value: string;
  icon: string;
  positive?: boolean;
}) {
  return (
    <div className="glass-card p-4 fade-in">
      <div className="flex items-center gap-2 mb-2">
        <span className="text-xl">{icon}</span>
        <span className="text-xs text-gray-500 font-medium">{label}</span>
      </div>
      <p
        className={`text-2xl font-bold font-mono ${
          positive === undefined
            ? "text-white"
            : positive
            ? "text-emerald-400"
            : "text-red-400"
        }`}
      >
        {value}
      </p>
    </div>
  );
}

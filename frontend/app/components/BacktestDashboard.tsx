"use client";

import { useCallback, useEffect, useState } from "react";
import {
  LineChart,
  Line,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  Legend,
  ResponsiveContainer,
  ReferenceLine,
} from "recharts";
import { format, parseISO } from "date-fns";
import QuantLabConfig from "./QuantLabConfig";
import TerminalConsole from "./TerminalConsole";
import PositionsTracker from "./PositionsTracker";
import ETFBreakdownTable from "./ETFBreakdownTable";

interface MetricsData {
  mode: string;
  runId: string | null;
  initialCapital: number;
  investmentMode?: string;
  monthlyContribution?: number;
  sharpe: number | null;
  spySharpe: number | null;
  maxDrawdown: number | null;
  spyMaxDrawdown: number | null;
  botReturn: number | null;
  spyReturn: number | null;
  botCagr: number | null;
  spyCagr: number | null;
  annualizedVol: number | null;
  spyAnnualizedVol: number | null;
  sortinoRatio: number | null;
  spySortinoRatio: number | null;
  calmarRatio: number | null;
  spyCalmarRatio: number | null;
  totalEquity: number | null;
  equityHistory: { date: string; bot: number; spy: number | null; injected: number | null }[];
  dataPoints: number;
  error?: string;
}

// ── Comparison KPI card ───────────────────────────────────────────────────────

function CompareCard({
  label,
  botValue,
  spyValue,
  botLabel = "🤖 Bot",
  spyLabel = "📊 SPY",
  format: fmt = (v: number) => v.toFixed(2),
  higherIsBetter = true,
}: {
  label: string;
  botValue: number | null;
  spyValue: number | null;
  botLabel?: string;
  spyLabel?: string;
  format?: (v: number) => string;
  higherIsBetter?: boolean;
}) {
  const botWins =
    botValue !== null && spyValue !== null
      ? higherIsBetter
        ? botValue > spyValue
        : botValue < spyValue
      : null;

  return (
    <div className="glass-card p-5 fade-in flex flex-col gap-3">
      {/* Header row: label left, badge right — never overlap */}
      <div className="flex items-start justify-between gap-2">
        <p className="text-xs text-gray-500 uppercase tracking-widest font-medium leading-tight">
          {label}
        </p>
        {botWins !== null && (
          <span
            className={`text-xs font-bold px-2 py-0.5 rounded flex-shrink-0 ${
              botWins
                ? "bg-emerald-900/40 text-emerald-400"
                : "bg-rose-900/40 text-rose-400"
            }`}
          >
            {botWins ? "✅ Bot Wins" : "❌ SPY Wins"}
          </span>
        )}
      </div>
      {/* Values row */}
      <div className="flex items-end gap-4">
        <div>
          <p className="text-xs text-gray-600 mb-0.5">{botLabel}</p>
          <p
            className={`text-2xl font-bold font-mono ${
              botWins === true
                ? "text-emerald-400"
                : botWins === false
                ? "text-rose-400"
                : "text-indigo-400"
            }`}
          >
            {botValue !== null ? fmt(botValue) : "—"}
          </p>
        </div>
        <div className="text-gray-700 text-xl pb-0.5">vs</div>
        <div>
          <p className="text-xs text-gray-600 mb-0.5">{spyLabel}</p>
          <p className="text-2xl font-bold font-mono text-gray-400">
            {spyValue !== null ? fmt(spyValue) : "—"}
          </p>
        </div>
      </div>
    </div>
  );
}

// ── Main component ────────────────────────────────────────────────────────────

export default function BacktestDashboard() {
  const [data, setData] = useState<MetricsData | null>(null);
  const [metricsLoading, setMetricsLoading] = useState(true);
  const [activeRunId, setActiveRunId] = useState<string | null>(null);
  const [isRunning, setIsRunning] = useState(false);
  const [tradesRefreshKey, setTradesRefreshKey] = useState(0);
  const [showBaseline, setShowBaseline] = useState(false);

  // Fetch metrics — optionally scoped to a run_id
  const fetchMetrics = useCallback((runId?: string | null) => {
    setMetricsLoading(true);
    const url = runId
      ? `/api/metrics?mode=backtest&run_id=${runId}`
      : "/api/metrics?mode=backtest";
    fetch(url, { cache: "no-store" })
      .then((r) => r.json())
      .then((json) => setData(json))
      .catch(() => setData(null))
      .finally(() => setMetricsLoading(false));
  }, []);

  // Load latest results on mount (no run_id filter → last backtest)
  useEffect(() => {
    fetchMetrics();
  }, [fetchMetrics]);

  function handleRunStart(runId: string) {
    setActiveRunId(runId);
    setIsRunning(true);
    setData(null);
    setMetricsLoading(false);
  }

  const handleRunComplete = useCallback(() => {
    setIsRunning(false);
    fetchMetrics(activeRunId);
    setTradesRefreshKey((k) => k + 1);
  }, [activeRunId, fetchMetrics]);

  const history = data?.equityHistory ?? [];
  const hasSpy = history.some((p) => p.spy !== null);
  const isEmpty = !metricsLoading && !isRunning && history.length < 2;

  const tickFormatter = (dateStr: string) => {
    try {
      return format(parseISO(dateStr), "MMM yy");
    } catch {
      return dateStr;
    }
  };

  return (
    <div className="fade-in">
      {/* ── Two-column layout: Config left, Results right ─────────────────── */}
      <div className="grid grid-cols-1 xl:grid-cols-[360px_1fr] gap-6 mb-6">
        {/* ── Left: Quant Lab config panel ───────────────────────────────── */}
        <div className="space-y-4">
          <QuantLabConfig onRunStart={handleRunStart} isRunning={isRunning} />

          {/* Terminal console — visible when a run is active */}
          {activeRunId && (
            <TerminalConsole
              runId={activeRunId}
              onComplete={handleRunComplete}
            />
          )}
        </div>

        {/* ── Right: Results panel ────────────────────────────────────────── */}
        <div>
          {/* Period badges */}
          <div className="flex flex-wrap items-center gap-3 mb-6">
            <span className="inline-flex items-center gap-2 text-xs font-semibold bg-indigo-900/40 border border-indigo-500/30 text-indigo-300 px-3 py-1.5 rounded-full">
              Training: 2012-2022 
            </span>
            <span className="inline-flex items-center gap-2 text-xs font-semibold bg-purple-900/40 border border-purple-500/30 text-purple-300 px-3 py-1.5 rounded-full">
              Backtesting: 2023-2026 
            </span>
            {data?.runId && (
              <span className="inline-flex items-center gap-2 text-xs font-semibold bg-gray-800/60 border border-gray-700 text-gray-400 px-3 py-1.5 rounded-full font-mono">
                run/{data.runId.slice(0, 8)}
              </span>
            )}
            {data && data.dataPoints > 0 && (
              <span className="inline-flex items-center gap-2 text-xs font-semibold bg-emerald-900/30 border border-emerald-700/30 text-emerald-400 px-3 py-1.5 rounded-full">
                {data.dataPoints} días simulados
              </span>
            )}
          </div>

          {/* KPI cards */}
          {metricsLoading ? (
            <div className="grid grid-cols-1 md:grid-cols-4 gap-4 mb-6">
              {[1, 2, 3, 4].map((i) => (
                <div key={i} className="glass-card p-5 animate-pulse h-28" />
              ))}
            </div>
          ) : isRunning && !data ? (
            <div className="grid grid-cols-1 md:grid-cols-4 gap-4 mb-6">
              {[1, 2, 3, 4].map((i) => (
                <div key={i} className="glass-card p-5 h-28 flex items-center justify-center">
                  <span className="text-xs text-gray-600">Waiting for results…</span>
                </div>
              ))}
            </div>
          ) : (
            <>
              <div className="grid grid-cols-1 md:grid-cols-4 gap-4 mb-6">
                <CompareCard
                  label="Retorno Total"
                  botValue={data?.botReturn ?? null}
                  spyValue={data?.spyReturn ?? null}
                  format={(v) => `${v >= 0 ? "+" : ""}${v.toFixed(2)}%`}
                  higherIsBetter
                />
                <CompareCard
                  label="Rentabilidad Anual (CAGR)"
                  botValue={data?.botCagr ?? null}
                  spyValue={data?.spyCagr ?? null}
                  format={(v) => `${v >= 0 ? "+" : ""}${v.toFixed(2)}%`}
                  higherIsBetter
                />
                <CompareCard
                  label="Sharpe Ratio (Rf = 4%)"
                  botValue={data?.sharpe ?? null}
                  spyValue={data?.spySharpe ?? null}
                  format={(v) => v.toFixed(2)}
                  higherIsBetter
                />
                <CompareCard
                  label="Max Drawdown"
                  botValue={data?.maxDrawdown ?? null}
                  spyValue={data?.spyMaxDrawdown ?? null}
                  format={(v) => `-${v.toFixed(2)}%`}
                  higherIsBetter={false}
                />
              </div>

              {/* ── Second KPI row: volatility metrics ─────────────────────── */}
              <div className="grid grid-cols-1 md:grid-cols-3 gap-4 mb-6">
                <CompareCard
                  label="Volatilidad Anualizada"
                  botValue={data?.annualizedVol ?? null}
                  spyValue={data?.spyAnnualizedVol ?? null}
                  format={(v) => `${v.toFixed(2)}%`}
                  higherIsBetter={false}
                />
                <CompareCard
                  label="Sortino Ratio (Rf = 4%)"
                  botValue={data?.sortinoRatio ?? null}
                  spyValue={data?.spySortinoRatio ?? null}
                  format={(v) => v.toFixed(2)}
                  higherIsBetter
                />
                <CompareCard
                  label="Calmar Ratio"
                  botValue={data?.calmarRatio ?? null}
                  spyValue={data?.spyCalmarRatio ?? null}
                  format={(v) => v.toFixed(2)}
                  higherIsBetter
                />
              </div>
            </>
          )}

          {/* ── Equity curve ───────────────────────────────────────────────── */}
          <div className="glass-card p-6 fade-in">
            <div className="flex items-start justify-between mb-5">
              <div>
                <span className="text-xs font-semibold text-purple-400 uppercase tracking-widest">
                  Out-of-Sample Validation · 2023 → 2026
                </span>
                <h2 className="text-lg font-bold text-white mt-1">
                  Curva de Equity — Bot vs S&P 500
                </h2>
                <p className="text-xs text-gray-500 mt-1">
                  Valor absoluto en USD · Ejecución al precio de apertura D+1 (sin data leakage)
                </p>
              </div>
              {data?.investmentMode === "PERIODIC" && (
                <button
                  onClick={() => setShowBaseline((v) => !v)}
                  className={`text-xs font-semibold px-3 py-1.5 rounded-lg border transition-colors flex-shrink-0 ${
                    showBaseline
                      ? "bg-slate-700 border-slate-500 text-slate-200"
                      : "bg-gray-900 border-gray-700 text-gray-400 hover:border-slate-500"
                  }`}
                >
                  {showBaseline ? "Ocultar capital inyectado" : "Mostrar capital inyectado"}
                </button>
              )}
            </div>

            {(metricsLoading || (isRunning && !data)) && (
              <div className="flex items-center justify-center h-64 text-gray-500 animate-pulse">
                {isRunning ? "Backtest en ejecución…" : "Cargando datos…"}
              </div>
            )}

            {isEmpty && (
              <div className="flex flex-col items-center justify-center h-64 gap-3 text-center">
                <span className="text-4xl">🧪</span>
                <p className="text-gray-400 font-medium">Backtest no ejecutado aún</p>
                <p className="text-gray-600 text-sm max-w-md">
                  Configure los parámetros y haz clic en{" "}
                  <strong className="text-indigo-400">Execute Quant Backtest</strong>.
                </p>
              </div>
            )}

            {!metricsLoading && !isEmpty && history.length >= 2 && (
              <ResponsiveContainer width="100%" height={340}>
                <LineChart
                  data={history}
                  margin={{ top: 5, right: 10, left: -10, bottom: 0 }}
                >
                  <CartesianGrid
                    strokeDasharray="3 3"
                    stroke="#1f2937"
                    vertical={false}
                  />
                  <XAxis
                    dataKey="date"
                    tick={{ fill: "#6b7280", fontSize: 11 }}
                    axisLine={false}
                    tickLine={false}
                    tickFormatter={tickFormatter}
                    interval="preserveStartEnd"
                  />
                  <YAxis
                    tick={{ fill: "#6b7280", fontSize: 11 }}
                    axisLine={false}
                    tickLine={false}
                    tickFormatter={(v: number) =>
                      v >= 1_000_000
                        ? `$${(v / 1_000_000).toFixed(1)}M`
                        : v >= 1_000
                        ? `$${(v / 1_000).toFixed(0)}k`
                        : `$${v.toFixed(0)}`
                    }
                    domain={["auto", "auto"]}
                  />
                  <Tooltip
                    contentStyle={{
                      backgroundColor: "#111827",
                      border: "1px solid #374151",
                      borderRadius: "0.5rem",
                      color: "#f9fafb",
                    }}
                    formatter={(value: number, name: string) => [
                      `$${value.toLocaleString("en-US", {
                        minimumFractionDigits: 2,
                        maximumFractionDigits: 2,
                      })}`,
                      name === "bot"
                        ? "🤖 Bot Portfolio"
                        : name === "injected"
                        ? "💰 Capital Inyectado"
                        : "📊 SPY Benchmark",
                    ]}
                  />
                  <Legend
                    formatter={(v) =>
                      v === "bot"
                        ? "🤖 Bot Portfolio"
                        : v === "injected"
                        ? "💰 Capital Inyectado"
                        : "📊 SPY Benchmark"
                    }
                    wrapperStyle={{ color: "#9ca3af", fontSize: "12px" }}
                  />
                  <ReferenceLine
                    y={data?.initialCapital ?? 100_000}
                    stroke="#374151"
                    strokeDasharray="4 4"
                  />
                  <Line
                    type="monotone"
                    dataKey="bot"
                    stroke="#8b5cf6"
                    strokeWidth={2.5}
                    dot={false}
                    activeDot={{ r: 4, fill: "#8b5cf6" }}
                  />
                  {hasSpy && (
                    <Line
                      type="monotone"
                      dataKey="spy"
                      stroke="#10b981"
                      strokeWidth={1.5}
                      strokeDasharray="6 3"
                      dot={false}
                      activeDot={{ r: 3, fill: "#10b981" }}
                    />
                  )}
                  {showBaseline && (
                    <Line
                      type="monotone"
                      dataKey="injected"
                      stroke="#94a3b8"
                      strokeWidth={1.5}
                      strokeDasharray="4 2"
                      dot={false}
                      activeDot={{ r: 3, fill: "#94a3b8" }}
                    />
                  )}
                </LineChart>
              </ResponsiveContainer>
            )}
          </div>

          {/* ── Per-ETF breakdown ──────────────────────────────────────────── */}
          <ETFBreakdownTable
            runId={activeRunId}
            refreshKey={tradesRefreshKey}
            isRunning={isRunning}
          />

          {/* ── Historical trade log ────────────────────────────────────────── */}
          <PositionsTracker
            runId={activeRunId}
            refreshKey={tradesRefreshKey}
            isRunning={isRunning}
          />
        </div>
      </div>
    </div>
  );
}

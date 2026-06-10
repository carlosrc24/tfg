"use client";

import { useEffect, useState } from "react";

interface ETFStat {
  etfId: string;
  symbol: string;
  buys: number;
  exits: number;
  totalPnl: number;
  winRate: number | null;
  avgPnlPerExit: number | null;
}

interface Props {
  runId: string | null;
  refreshKey?: number;
  isRunning?: boolean;
}

const ETF_COLORS: Record<string, string> = {
  QQQ:  "#3b82f6",
  SPY:  "#10b981",
  IWM:  "#8b5cf6",
  GLD:  "#eab308",
  XLF:  "#06b6d4",
  SMH:  "#f43f5e",
  XLE:  "#f97316",
  ARKK: "#d946ef",
};

const ETF_AVATAR: Record<string, string> = {
  QQQ:  "bg-blue-900/60    text-blue-300",
  SPY:  "bg-emerald-900/60 text-emerald-300",
  IWM:  "bg-violet-900/60  text-violet-300",
  GLD:  "bg-yellow-900/60  text-yellow-300",
  XLF:  "bg-cyan-900/60    text-cyan-300",
  SMH:  "bg-rose-900/60    text-rose-300",
  XLE:  "bg-orange-900/60  text-orange-300",
  ARKK: "bg-fuchsia-900/60 text-fuchsia-300",
};

const fmtUSD = (v: number) =>
  v.toLocaleString("en-US", {
    style: "currency",
    currency: "USD",
    minimumFractionDigits: 0,
    maximumFractionDigits: 0,
  });

export default function ETFBreakdownTable({ runId, refreshKey = 0, isRunning = false }: Props) {
  const [stats, setStats] = useState<ETFStat[] | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!runId) { setStats(null); return; }

    let cancelled = false;
    setLoading(true);
    setError(null);

    fetch(`/api/backtest/etf-stats/${runId}`, { cache: "no-store" })
      .then((r) => r.json())
      .then((json) => {
        if (cancelled) return;
        if (json.error) { setError(json.error); setStats(null); }
        else setStats(json.etfStats ?? []);
      })
      .catch((e: unknown) => {
        if (!cancelled) setError(e instanceof Error ? e.message : "Network error");
      })
      .finally(() => { if (!cancelled) setLoading(false); });

    return () => { cancelled = true; };
  }, [runId, refreshKey]);

  if (!runId) return null;

  const bestPnl = stats && stats.length > 0 ? stats[0].symbol : null;

  return (
    <div className="glass-card p-6 fade-in mt-4">
      <div className="mb-5">
        <span className="text-xs font-semibold text-indigo-400 uppercase tracking-widest">
          Per-ETF Breakdown · run/{runId.slice(0, 8)}
        </span>
        <h2 className="text-lg font-bold text-white mt-1">ETF Performance Summary</h2>
        <p className="text-xs text-gray-500 mt-0.5">
          Realised P&amp;L · trade counts · win rate per asset · sorted by total P&amp;L
        </p>
      </div>

      {error && (
        <p className="text-xs text-rose-400 bg-rose-950/40 border border-rose-800/40 rounded-lg px-3 py-2 mb-4">
          {error}
        </p>
      )}

      {(loading || (isRunning && !stats)) && (
        <div className="space-y-2">
          {[1, 2, 3, 4, 5, 6, 7, 8].map((i) => (
            <div key={i} className="h-10 rounded-lg bg-gray-800/60 animate-pulse" />
          ))}
          {isRunning && (
            <p className="text-xs text-gray-500 pt-1 text-center">
              ETF breakdown will appear once the simulation completes.
            </p>
          )}
        </div>
      )}

      {!loading && stats && stats.length === 0 && (
        <p className="text-gray-500 text-sm text-center py-8">No trades recorded for this run.</p>
      )}

      {!loading && stats && stats.length > 0 && (
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-gray-800">
                {["ETF", "Buys", "Exits", "Win Rate", "Avg P&L / Exit", "Total P&L"].map((h) => (
                  <th
                    key={h}
                    className={`py-2 px-3 text-gray-500 font-medium text-xs uppercase tracking-wider ${
                      h === "ETF" ? "text-left" : "text-right"
                    }`}
                  >
                    {h}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {stats.map((row) => {
                const isBest = row.symbol === bestPnl && row.totalPnl > 0;
                const avatarCls = ETF_AVATAR[row.symbol] ?? "bg-gray-800 text-gray-400";
                const color = ETF_COLORS[row.symbol] ?? "#6b7280";

                return (
                  <tr
                    key={row.etfId}
                    className={`border-b border-gray-800/50 hover:bg-gray-800/30 transition-colors ${
                      isBest ? "bg-emerald-950/20" : ""
                    }`}
                  >
                    {/* ETF name */}
                    <td className="py-3 px-3">
                      <div className="flex items-center gap-2">
                        <span
                          className="w-2.5 h-2.5 rounded-full flex-shrink-0"
                          style={{ backgroundColor: color }}
                        />
                        <span
                          className={`w-6 h-6 rounded-full flex items-center justify-center text-xs font-bold flex-shrink-0 ${avatarCls}`}
                        >
                          {row.symbol.charAt(0)}
                        </span>
                        <span className="font-mono font-semibold text-indigo-300">{row.symbol}</span>
                        {isBest && (
                          <span className="text-xs bg-emerald-900/50 text-emerald-400 border border-emerald-700/40 rounded px-1.5 py-0.5 font-semibold">
                            Best
                          </span>
                        )}
                      </div>
                    </td>

                    {/* Buys */}
                    <td className="py-3 px-3 text-right font-mono text-gray-300">{row.buys}</td>

                    {/* Exits */}
                    <td className="py-3 px-3 text-right font-mono text-gray-300">{row.exits}</td>

                    {/* Win rate */}
                    <td className="py-3 px-3 text-right font-mono">
                      {row.winRate !== null ? (
                        <span
                          className={
                            row.winRate >= 55
                              ? "text-emerald-400"
                              : row.winRate >= 45
                              ? "text-yellow-400"
                              : "text-rose-400"
                          }
                        >
                          {row.winRate.toFixed(1)}%
                        </span>
                      ) : (
                        <span className="text-gray-600">—</span>
                      )}
                    </td>

                    {/* Avg P&L per exit */}
                    <td className="py-3 px-3 text-right font-mono text-sm">
                      {row.avgPnlPerExit !== null ? (
                        <span
                          className={row.avgPnlPerExit >= 0 ? "text-emerald-400" : "text-rose-400"}
                        >
                          {row.avgPnlPerExit >= 0 ? "+" : ""}
                          {fmtUSD(row.avgPnlPerExit)}
                        </span>
                      ) : (
                        <span className="text-gray-600">—</span>
                      )}
                    </td>

                    {/* Total P&L */}
                    <td className="py-3 px-3 text-right font-mono font-semibold text-sm">
                      <span className={row.totalPnl >= 0 ? "text-emerald-400" : "text-rose-400"}>
                        {row.totalPnl >= 0 ? "+" : ""}
                        {fmtUSD(row.totalPnl)}
                      </span>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

"use client";

import { useEffect, useState } from "react";
import { format, parseISO } from "date-fns";
import {
  PieChart,
  Pie,
  Cell,
  Tooltip,
  ResponsiveContainer,
} from "recharts";
import {
  Table,
  TableHead,
  TableHeaderCell,
  TableBody,
  TableRow,
  TableCell,
  Badge,
} from "@tremor/react";

// ── Types ──────────────────────────────────────────────────────────────────────

interface TradeRow {
  id: string;
  etf_id: string;
  timestamp: string;
  action: string;
  price: number;
  quantity: number;
  profit_loss: number | null;
}

interface OpenPosition {
  etfId: string;
  symbol: string;
  qty: number;
  avg_entry_price: number;
  cost_basis: number;
}

interface ApiResponse {
  openPositions: OpenPosition[];
  trades: TradeRow[];
  tradeCount: number;
  finalCash: number;
  totalOpenMarketValue: number | null;
  totalPnL: number;
  symbolMap: Record<string, string>;
  error?: string;
}

interface Props {
  runId: string | null;
  refreshKey?: number;
  isRunning?: boolean;
}

// ── Colours ────────────────────────────────────────────────────────────────────

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
const CASH_COLOR = "#4b5563";

// ── Action badge resolver ──────────────────────────────────────────────────────

type TremorColor =
  | "emerald" | "rose" | "amber" | "gray" | "indigo"
  | "blue" | "violet" | "slate";

function resolveAction(
  action: string,
  profitLoss: number | null,
): { color: TremorColor; label: string } {
  if (action === "BUY") return { color: "emerald", label: "LONG ENTRY" };
  if (profitLoss === null) return { color: "gray", label: "SELL" };
  if (profitLoss > 0) return { color: "emerald", label: "PROFIT EXIT" };
  if (profitLoss === 0) return { color: "amber", label: "BREAK EVEN" };
  return { color: "rose", label: "STOP LOSS" };
}

// ── Helpers ────────────────────────────────────────────────────────────────────

const fmtUSD = (v: number) =>
  v.toLocaleString("en-US", {
    style: "currency",
    currency: "USD",
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });

const TH =
  "!bg-transparent !text-gray-500 !text-xs !uppercase !tracking-wider !font-medium !py-3 !border-gray-800/60";
const TR_BODY =
  "!border-gray-800/50 hover:!bg-gray-800/30 !transition-colors";
const TD = "!py-3 !text-gray-300";

// ── Component ──────────────────────────────────────────────────────────────────

export default function PositionsTracker({
  runId,
  refreshKey = 0,
  isRunning = false,
}: Props) {
  const [data, setData] = useState<ApiResponse | null>(null);
  const [loading, setLoading] = useState(false);
  const [fetchError, setFetchError] = useState<string | null>(null);

  useEffect(() => {
    if (!runId) {
      setData(null);
      setFetchError(null);
      return;
    }

    let cancelled = false;
    setLoading(true);
    setFetchError(null);

    fetch(`/api/backtest/positions/${runId}`, { cache: "no-store" })
      .then((res) => res.json())
      .then((json: ApiResponse) => {
        if (cancelled) return;
        if (json.error) {
          setFetchError(json.error);
          setData(null);
        } else {
          setData(json);
        }
      })
      .catch((err: unknown) => {
        if (cancelled) return;
        setFetchError(err instanceof Error ? err.message : "Network error");
        setData(null);
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });

    return () => {
      cancelled = true;
    };
  }, [runId, refreshKey]);

  if (!runId) return null;

  // ── Derived values ─────────────────────────────────────────────────────────

  const openPositions = data?.openPositions ?? [];
  const trades = data?.trades ?? [];
  const tradeCount = data?.tradeCount ?? 0;
  const finalCash = data?.finalCash ?? 0;
  const totalOpenMarketValue = data?.totalOpenMarketValue ?? null;
  const totalPnL = data?.totalPnL ?? 0;
  const symbolMap = data?.symbolMap ?? {};

  const totalCostBasis = openPositions.reduce((s, p) => s + p.cost_basis, 0);

  const positionMktValues: Record<string, number> = {};
  if (totalOpenMarketValue !== null && totalCostBasis > 0) {
    openPositions.forEach((p) => {
      positionMktValues[p.etfId] =
        totalOpenMarketValue * (p.cost_basis / totalCostBasis);
    });
  } else {
    openPositions.forEach((p) => {
      positionMktValues[p.etfId] = p.cost_basis;
    });
  }

  const unrealizedPL =
    totalOpenMarketValue !== null
      ? totalOpenMarketValue - totalCostBasis
      : null;
  const unrealizedPLPct =
    unrealizedPL !== null && totalCostBasis > 0
      ? (unrealizedPL / totalCostBasis) * 100
      : null;

  const donutData: { name: string; value: number; color: string }[] = [
    ...openPositions.map((p) => ({
      name: p.symbol,
      value: Math.max(0, positionMktValues[p.etfId] ?? p.cost_basis),
      color: ETF_COLORS[p.symbol] ?? "#6b7280",
    })),
    ...(finalCash > 0.01
      ? [{ name: "Cash", value: finalCash, color: CASH_COLOR }]
      : []),
  ].filter((d) => d.value > 0);

  const totalPortfolioValue = donutData.reduce((s, d) => s + d.value, 0);

  const showSkeleton = loading || (isRunning && !data);

  return (
    <div className="space-y-4 mt-4">
      {/* ── Section 1: Final Portfolio Allocation ───────────────────────────── */}
      <div className="glass-card p-6 fade-in">
        {/* Header */}
        <div className="flex items-start justify-between flex-wrap gap-3 mb-5">
          <div>
            <span className="text-xs font-semibold text-purple-400 uppercase tracking-widest">
              Simulation End State · run/{runId.slice(0, 8)}
            </span>
            <h2 className="text-lg font-bold text-white mt-1">
              Final Portfolio Allocation
            </h2>
            <p className="text-xs text-gray-500 mt-0.5">
              Asset allocation when the simulation ended
            </p>
          </div>

          {!isRunning && unrealizedPL !== null && openPositions.length > 0 && (
            <div className="text-right">
              <p className="text-xs text-gray-500 mb-0.5">Unrealised P&amp;L</p>
              <p
                className={`text-2xl font-bold font-mono ${
                  unrealizedPL >= 0 ? "text-emerald-400" : "text-rose-400"
                }`}
              >
                {unrealizedPL >= 0 ? "+" : ""}
                {fmtUSD(unrealizedPL)}
              </p>
              {unrealizedPLPct !== null && (
                <p
                  className={`text-xs font-mono mt-0.5 ${
                    unrealizedPLPct >= 0 ? "text-emerald-500" : "text-rose-500"
                  }`}
                >
                  {unrealizedPLPct >= 0 ? "+" : ""}
                  {unrealizedPLPct.toFixed(2)}%
                </p>
              )}
            </div>
          )}
        </div>

        {/* API error */}
        {fetchError && (
          <p className="text-xs text-rose-400 bg-rose-950/40 border border-rose-800/40 rounded-lg px-3 py-2 mb-4">
            {fetchError}
          </p>
        )}

        {/* Skeleton */}
        {showSkeleton && (
          <div className="flex flex-col md:flex-row gap-6 items-center">
            <div
              className="flex-shrink-0 rounded-full bg-gray-800/60 animate-pulse"
              style={{ width: 200, height: 200 }}
            />
            <div className="flex-1 space-y-3 w-full">
              {[1, 2, 3].map((i) => (
                <div key={i} className="h-8 rounded-lg bg-gray-800/60 animate-pulse" />
              ))}
              {isRunning && (
                <p className="text-xs text-gray-500 pt-1">
                  Positions will appear here once the simulation completes.
                </p>
              )}
            </div>
          </div>
        )}

        {/* Data */}
        {!showSkeleton && data && (
          <div className="flex flex-col md:flex-row gap-6 items-start">
            {/* Donut */}
            <div className="flex-shrink-0 flex flex-col items-center gap-3">
              <div className="relative" style={{ width: 200, height: 200 }}>
                <ResponsiveContainer width="100%" height="100%">
                  <PieChart>
                    <Pie
                      data={
                        donutData.length > 0
                          ? donutData
                          : [{ name: "—", value: 1, color: "#1f2937" }]
                      }
                      cx="50%"
                      cy="50%"
                      innerRadius={58}
                      outerRadius={82}
                      paddingAngle={donutData.length > 1 ? 2 : 0}
                      dataKey="value"
                      stroke="none"
                      startAngle={90}
                      endAngle={-270}
                    >
                      {(donutData.length > 0
                        ? donutData
                        : [{ name: "—", value: 1, color: "#1f2937" }]
                      ).map((entry, i) => (
                        <Cell key={i} fill={entry.color} />
                      ))}
                    </Pie>
                    <Tooltip
                      contentStyle={{
                        backgroundColor: "#111827",
                        border: "1px solid #374151",
                        borderRadius: "0.5rem",
                        color: "#f9fafb",
                        fontSize: "12px",
                      }}
                      formatter={(value: number, name: string) => [
                        fmtUSD(value),
                        name,
                      ]}
                    />
                  </PieChart>
                </ResponsiveContainer>
                <div className="absolute inset-0 flex flex-col items-center justify-center pointer-events-none">
                  <p className="text-xs text-gray-500">Portfolio</p>
                  <p className="text-sm font-bold text-white font-mono leading-tight">
                    {totalPortfolioValue > 0 ? fmtUSD(totalPortfolioValue) : "—"}
                  </p>
                </div>
              </div>

              {donutData.length > 0 && (
                <div className="flex flex-wrap justify-center gap-x-3 gap-y-1 max-w-[200px]">
                  {donutData.map((d) => (
                    <div key={d.name} className="flex items-center gap-1">
                      <span
                        className="w-2 h-2 rounded-full flex-shrink-0"
                        style={{ backgroundColor: d.color }}
                      />
                      <span className="text-xs text-gray-400 font-mono">
                        {d.name}
                      </span>
                    </div>
                  ))}
                </div>
              )}
            </div>

            {/* Detail panel */}
            <div className="flex-1 w-full min-w-0">
              {openPositions.length === 0 ? (
                <div className="space-y-3">
                  <div className="flex items-center gap-3 py-4 px-4 bg-emerald-950/30 border border-emerald-800/30 rounded-lg">
                    <span className="text-emerald-400 text-xl">✓</span>
                    <div>
                      <p className="text-sm font-semibold text-emerald-400">
                        Fully in cash
                      </p>
                      <p className="text-xs text-gray-500 mt-0.5">
                        All positions were closed before the simulation ended.
                      </p>
                    </div>
                  </div>
                  <div className="flex items-center justify-between px-4 py-3 bg-gray-800/40 rounded-lg">
                    <div className="flex items-center gap-2">
                      <span
                        className="w-2.5 h-2.5 rounded-full"
                        style={{ backgroundColor: CASH_COLOR }}
                      />
                      <span className="text-sm text-gray-300 font-mono">Cash</span>
                    </div>
                    <span className="text-sm font-bold font-mono text-white">
                      {fmtUSD(finalCash)}
                    </span>
                  </div>
                </div>
              ) : (
                <div className="overflow-x-auto">
                  <table className="w-full text-sm">
                    <thead>
                      <tr className="border-b border-gray-800">
                        {["Asset", "Shares", "Avg Entry", "Mkt Value", "P&L"].map(
                          (h) => (
                            <th
                              key={h}
                              className={`py-2 px-2 text-gray-500 font-medium text-xs uppercase tracking-wider ${
                                h === "Asset" ? "text-left" : "text-right"
                              }`}
                            >
                              {h}
                            </th>
                          )
                        )}
                      </tr>
                    </thead>
                    <tbody>
                      {openPositions.map((pos) => {
                        const mktVal =
                          positionMktValues[pos.etfId] ?? pos.cost_basis;
                        const unrPL = mktVal - pos.cost_basis;
                        const unrPct =
                          pos.cost_basis > 0
                            ? (unrPL / pos.cost_basis) * 100
                            : 0;
                        const avatarCls =
                          ETF_AVATAR[pos.symbol] ?? "bg-gray-800 text-gray-400";
                        return (
                          <tr
                            key={pos.etfId}
                            className="border-b border-gray-800/50 hover:bg-gray-800/30 transition-colors"
                          >
                            <td className="py-2.5 px-2">
                              <div className="flex items-center gap-2">
                                <span
                                  className="w-2.5 h-2.5 rounded-full flex-shrink-0"
                                  style={{
                                    backgroundColor:
                                      ETF_COLORS[pos.symbol] ?? "#6b7280",
                                  }}
                                />
                                <span
                                  className={`w-6 h-6 rounded-full flex items-center justify-center text-xs font-bold flex-shrink-0 ${avatarCls}`}
                                >
                                  {pos.symbol.charAt(0)}
                                </span>
                                <span className="font-mono font-semibold text-indigo-300 text-sm">
                                  {pos.symbol}
                                </span>
                              </div>
                            </td>
                            <td className="py-2.5 px-2 text-right font-mono text-gray-200 text-sm">
                              {pos.qty.toFixed(4)}
                            </td>
                            <td className="py-2.5 px-2 text-right font-mono text-gray-400 text-sm">
                              {fmtUSD(pos.avg_entry_price)}
                            </td>
                            <td className="py-2.5 px-2 text-right font-mono text-white font-semibold text-sm">
                              {totalOpenMarketValue !== null
                                ? fmtUSD(mktVal)
                                : fmtUSD(pos.cost_basis)}
                            </td>
                            <td className="py-2.5 px-2 text-right font-mono text-sm">
                              {totalOpenMarketValue !== null ? (
                                <div
                                  className={`flex flex-col items-end ${
                                    unrPL >= 0 ? "text-emerald-400" : "text-rose-400"
                                  }`}
                                >
                                  <span>
                                    {unrPL >= 0 ? "+" : ""}
                                    {fmtUSD(unrPL)}
                                  </span>
                                  <span className="text-xs opacity-70">
                                    {unrPct >= 0 ? "+" : ""}
                                    {unrPct.toFixed(2)}%
                                  </span>
                                </div>
                              ) : (
                                <span className="text-gray-600">—</span>
                              )}
                            </td>
                          </tr>
                        );
                      })}

                      {finalCash > 0.01 && (
                        <tr className="border-b border-gray-800/50">
                          <td className="py-2.5 px-2">
                            <div className="flex items-center gap-2">
                              <span
                                className="w-2.5 h-2.5 rounded-full flex-shrink-0"
                                style={{ backgroundColor: CASH_COLOR }}
                              />
                              <span className="text-sm text-gray-400 font-mono pl-8">
                                Cash
                              </span>
                            </div>
                          </td>
                          <td
                            colSpan={2}
                            className="py-2.5 px-2 text-right text-gray-600 text-xs"
                          >
                            available balance
                          </td>
                          <td className="py-2.5 px-2 text-right font-mono text-gray-300 font-semibold text-sm">
                            {fmtUSD(finalCash)}
                          </td>
                          <td className="py-2.5 px-2 text-right text-gray-600 text-sm">
                            —
                          </td>
                        </tr>
                      )}
                    </tbody>
                  </table>
                  {openPositions.length > 1 && totalOpenMarketValue !== null && (
                    <p className="text-xs text-gray-600 mt-3">
                      Per-position market values are estimated proportionally to
                      cost basis. The total is exact (from the final equity
                      snapshot).
                    </p>
                  )}
                </div>
              )}
            </div>
          </div>
        )}
      </div>

      {/* ── Section 2: Historical Trade Log ──────────────────────────────────── */}
      <div className="glass-card p-6 fade-in">
        <div className="flex items-start justify-between flex-wrap gap-3 mb-5">
          <div>
            <span className="text-xs font-semibold text-indigo-400 uppercase tracking-widest">
              Historical Trade Log · run/{runId.slice(0, 8)}
            </span>
            <h2 className="text-lg font-bold text-white mt-1">
              Execution History
            </h2>
            <p className="text-xs text-gray-500 mt-0.5">
              All simulated trades · D+1 open price · most recent first
            </p>
          </div>

          <div className="flex items-end gap-6">
            {!loading && tradeCount > 0 && (
              <div className="text-right">
                <p className="text-xs text-gray-500 mb-0.5">Total Trades</p>
                <p className="text-2xl font-bold font-mono text-indigo-300">
                  {tradeCount}
                </p>
              </div>
            )}
            {!loading && data && (
              <div className="text-right">
                <p className="text-xs text-gray-500 mb-0.5">Realised P&amp;L</p>
                <p
                  className={`text-2xl font-bold font-mono ${
                    totalPnL >= 0 ? "text-emerald-400" : "text-rose-400"
                  }`}
                >
                  {totalPnL >= 0 ? "+" : ""}
                  {fmtUSD(totalPnL)}
                </p>
              </div>
            )}
          </div>
        </div>

        {loading && (
          <div className="flex items-center justify-center h-32 text-gray-500 animate-pulse text-sm">
            Loading trade history…
          </div>
        )}

        {!loading && !data && !fetchError && (
          <div className="flex items-center justify-center h-32">
            <p className="text-gray-500 text-sm">
              {isRunning
                ? "Trades will appear here as the simulation progresses."
                : "No data available."}
            </p>
          </div>
        )}

        {!loading && data && trades.length === 0 && (
          <div className="flex flex-col items-center justify-center h-32 gap-2 text-center">
            <p className="text-gray-500 text-sm">
              {isRunning
                ? "Trades will appear here as the simulation progresses."
                : "No trades recorded for this run."}
            </p>
          </div>
        )}

        {!loading && trades.length > 0 && (
          <div className="overflow-x-auto">
            <Table className="mt-0 min-w-full">
              <TableHead>
                <TableRow className="!border-gray-800/60">
                  <TableHeaderCell className={TH}>Date / Time</TableHeaderCell>
                  <TableHeaderCell className={TH}>Asset</TableHeaderCell>
                  <TableHeaderCell className={TH}>Action</TableHeaderCell>
                  <TableHeaderCell className={`${TH} text-right`}>Shares</TableHeaderCell>
                  <TableHeaderCell className={`${TH} text-right`}>Exec Price</TableHeaderCell>
                  <TableHeaderCell className={`${TH} text-right`}>Total Value</TableHeaderCell>
                  <TableHeaderCell className={`${TH} text-right`}>P&amp;L</TableHeaderCell>
                </TableRow>
              </TableHead>

              <TableBody>
                {trades.map((trade) => {
                  const symbol = symbolMap[trade.etf_id] ?? "?";
                  const { color, label } = resolveAction(
                    trade.action,
                    trade.profit_loss,
                  );
                  const totalVal = trade.price * trade.quantity;
                  const avatarCls =
                    ETF_AVATAR[symbol] ?? "bg-gray-800 text-gray-400";

                  return (
                    <TableRow key={trade.id} className={TR_BODY}>
                      <TableCell className={`${TD} font-mono text-xs text-gray-400 whitespace-nowrap`}>
                        {format(parseISO(trade.timestamp), "dd MMM yy · HH:mm")}
                      </TableCell>
                      <TableCell className={TD}>
                        <div className="flex items-center gap-2">
                          <span
                            className={`w-7 h-7 rounded-full flex items-center justify-center text-xs font-bold flex-shrink-0 ${avatarCls}`}
                          >
                            {symbol.charAt(0)}
                          </span>
                          <span className="font-mono font-semibold text-indigo-300 text-sm">
                            {symbol}
                          </span>
                        </div>
                      </TableCell>
                      <TableCell className={TD}>
                        <Badge color={color} size="sm">{label}</Badge>
                      </TableCell>
                      <TableCell className={`${TD} text-right font-mono text-sm`}>
                        {trade.quantity.toFixed(4)}
                      </TableCell>
                      <TableCell className={`${TD} text-right font-mono text-sm text-gray-200`}>
                        {fmtUSD(trade.price)}
                      </TableCell>
                      <TableCell className={`${TD} text-right font-mono text-sm`}>
                        {fmtUSD(totalVal)}
                      </TableCell>
                      <TableCell className={`${TD} text-right font-mono text-sm`}>
                        {trade.profit_loss !== null ? (
                          <span
                            className={
                              trade.profit_loss >= 0
                                ? "text-emerald-400"
                                : "text-rose-400"
                            }
                          >
                            {trade.profit_loss >= 0 ? "+" : ""}
                            {fmtUSD(trade.profit_loss)}
                          </span>
                        ) : (
                          <span className="text-gray-600">—</span>
                        )}
                      </TableCell>
                    </TableRow>
                  );
                })}
              </TableBody>
            </Table>

            {tradeCount > 500 && (
              <p className="text-xs text-gray-600 text-center mt-3">
                Showing the latest 500 of {tradeCount} trades for this run.
              </p>
            )}
          </div>
        )}
      </div>
    </div>
  );
}

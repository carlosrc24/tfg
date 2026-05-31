"use client";

import { useEffect, useState } from "react";
import { format, parseISO } from "date-fns";
import {
  Table,
  TableHead,
  TableHeaderCell,
  TableBody,
  TableRow,
  TableCell,
  Badge,
} from "@tremor/react";
import { supabase } from "../../lib/supabase";

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

interface Props {
  runId: string | null;
  refreshKey?: number;
}

// ── ETF avatar colours ─────────────────────────────────────────────────────────

const ETF_AVATAR: Record<string, string> = {
  QQQ:  "bg-blue-900/60   text-blue-300",
  SPY:  "bg-emerald-900/60 text-emerald-300",
  IWM:  "bg-violet-900/60 text-violet-300",
  GLD:  "bg-yellow-900/60 text-yellow-300",
  XLF:  "bg-cyan-900/60   text-cyan-300",
  SMH:  "bg-rose-900/60   text-rose-300",
  XLE:  "bg-orange-900/60 text-orange-300",
  ARKK: "bg-fuchsia-900/60 text-fuchsia-300",
};

// ── Action badge resolver ──────────────────────────────────────────────────────

type TremorColor =
  | "emerald" | "rose" | "amber" | "gray" | "indigo"
  | "blue" | "violet" | "slate";

function resolveAction(
  action: string,
  profitLoss: number | null,
): { color: TremorColor; label: string } {
  if (action === "BUY") {
    return { color: "emerald", label: "LONG ENTRY" };
  }
  // All SELL variants — distinguish by outcome
  if (profitLoss === null) {
    return { color: "gray", label: "SELL" };
  }
  if (profitLoss > 0) {
    return { color: "emerald", label: "PROFIT EXIT" };
  }
  if (profitLoss === 0) {
    return { color: "amber", label: "BREAK EVEN" };
  }
  // profitLoss < 0 — could be trailing stop or signal exit
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

// Shared dark-theme className overrides for Tremor table primitives
const TH =
  "!bg-transparent !text-gray-500 !text-xs !uppercase !tracking-wider !font-medium !py-3 !border-gray-800/60";
const TR_BODY =
  "!border-gray-800/50 hover:!bg-gray-800/30 !transition-colors";
const TD = "!py-3 !text-gray-300";

// ── Component ──────────────────────────────────────────────────────────────────

export default function PositionsTracker({ runId, refreshKey = 0 }: Props) {
  const [trades, setTrades] = useState<TradeRow[]>([]);
  const [etfSymbols, setEtfSymbols] = useState<Record<string, string>>({});
  const [loading, setLoading] = useState(false);
  const [totalPnL, setTotalPnL] = useState(0);
  const [tradeCount, setTradeCount] = useState(0);

  useEffect(() => {
    if (!runId) {
      setTrades([]);
      setTotalPnL(0);
      setTradeCount(0);
      return;
    }

    let cancelled = false;
    setLoading(true);

    async function load() {
      const [{ data: etfs }, { data: tradeData }] = await Promise.all([
        supabase.from("etfs").select("id, symbol"),
        supabase
          .from("trades")
          .select("*")
          .eq("run_id", runId)
          .order("timestamp", { ascending: false }),
      ]);

      if (cancelled) return;

      const symbolMap: Record<string, string> = {};
      (etfs ?? []).forEach((e: { id: string; symbol: string }) => {
        symbolMap[e.id] = e.symbol;
      });

      const rows = tradeData ?? [];
      const pnl = rows.reduce((sum, t) => sum + (t.profit_loss ?? 0), 0);

      setEtfSymbols(symbolMap);
      setTrades(rows);
      setTotalPnL(pnl);
      setTradeCount(rows.length);
      setLoading(false);
    }

    load();
    return () => {
      cancelled = true;
    };
  }, [runId, refreshKey]);

  // Don't render at all until a run has been launched
  if (!runId) return null;

  return (
    <div className="glass-card p-6 fade-in">
      {/* ── Header ─────────────────────────────────────────────────────────── */}
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
          {!loading && (
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

      {/* ── Loading state ───────────────────────────────────────────────────── */}
      {loading && (
        <div className="flex items-center justify-center h-32 text-gray-500 animate-pulse text-sm">
          Loading trade history…
        </div>
      )}

      {/* ── Empty state ─────────────────────────────────────────────────────── */}
      {!loading && trades.length === 0 && (
        <div className="flex flex-col items-center justify-center h-32 gap-2 text-center">
          <p className="text-gray-500 text-sm">
            No trades recorded for this run yet.
          </p>
          <p className="text-gray-600 text-xs">
            Trades appear here once the backtest completes.
          </p>
        </div>
      )}

      {/* ── Table ───────────────────────────────────────────────────────────── */}
      {!loading && trades.length > 0 && (
        <div className="overflow-x-auto">
          <Table className="mt-0 min-w-full">
            <TableHead>
              <TableRow className="!border-gray-800/60">
                <TableHeaderCell className={TH}>Date / Time</TableHeaderCell>
                <TableHeaderCell className={TH}>Asset</TableHeaderCell>
                <TableHeaderCell className={TH}>Action</TableHeaderCell>
                <TableHeaderCell className={`${TH} text-right`}>
                  Shares
                </TableHeaderCell>
                <TableHeaderCell className={`${TH} text-right`}>
                  Exec Price
                </TableHeaderCell>
                <TableHeaderCell className={`${TH} text-right`}>
                  Total Value
                </TableHeaderCell>
                <TableHeaderCell className={`${TH} text-right`}>
                  P&amp;L
                </TableHeaderCell>
              </TableRow>
            </TableHead>

            <TableBody>
              {trades.map((trade) => {
                const symbol = etfSymbols[trade.etf_id] ?? "?";
                const { color, label } = resolveAction(
                  trade.action,
                  trade.profit_loss,
                );
                const totalVal = trade.price * trade.quantity;
                const avatarCls =
                  ETF_AVATAR[symbol] ?? "bg-gray-800 text-gray-400";

                return (
                  <TableRow key={trade.id} className={TR_BODY}>
                    {/* Date */}
                    <TableCell className={`${TD} font-mono text-xs text-gray-400 whitespace-nowrap`}>
                      {format(parseISO(trade.timestamp), "dd MMM yy · HH:mm")}
                    </TableCell>

                    {/* Asset */}
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

                    {/* Action badge */}
                    <TableCell className={TD}>
                      <Badge color={color} size="sm">
                        {label}
                      </Badge>
                    </TableCell>

                    {/* Shares */}
                    <TableCell className={`${TD} text-right font-mono text-sm`}>
                      {trade.quantity.toFixed(4)}
                    </TableCell>

                    {/* Exec price */}
                    <TableCell className={`${TD} text-right font-mono text-sm text-gray-200`}>
                      {fmtUSD(trade.price)}
                    </TableCell>

                    {/* Total value */}
                    <TableCell className={`${TD} text-right font-mono text-sm`}>
                      {fmtUSD(totalVal)}
                    </TableCell>

                    {/* P&L */}
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

          {tradeCount >= 500 && (
            <p className="text-xs text-gray-600 text-center mt-3">
              Showing the latest 500 trades of this run.
            </p>
          )}
        </div>
      )}
    </div>
  );
}

"use client";

import { useEffect, useState } from "react";

interface Position {
  symbol: string;
  side: string;
  qty: number;
  avg_entry_price: number;
  current_price: number;
  unrealized_pl: number;
  unrealized_plpc: number;
  market_value: number;
}

interface AccountSummary {
  portfolio_value: number;
  buying_power: number;
  cash: number;
}

export default function PositionsTable() {
  const [positions, setPositions] = useState<Position[]>([]);
  const [account, setAccount] = useState<AccountSummary | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  async function refresh() {
    try {
      const res = await fetch("/api/positions", { cache: "no-store" });
      const json = await res.json();
      if (json.error) throw new Error(json.error);
      setPositions(json.positions ?? []);
      setAccount({
        portfolio_value: json.portfolio_value,
        buying_power: json.buying_power,
        cash: json.cash,
      });
      setError(null);
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : "Error");
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    refresh();
    const id = setInterval(refresh, 60_000); // refresh every 60 s
    return () => clearInterval(id);
  }, []);

  return (
    <div className="glass-card p-6 fade-in">
      {/* Header */}
      <div className="flex items-center justify-between mb-5">
        <div>
          <span className="text-xs font-semibold text-indigo-400 uppercase tracking-widest">
            Alpaca Paper Trading
          </span>
          <h2 className="text-lg font-bold text-white mt-1">
            Posiciones Actuales
          </h2>
        </div>
        <div className="flex items-center gap-2">
          <span className="pulse-dot w-2 h-2 rounded-full bg-emerald-400 inline-block" />
          <span className="text-xs text-gray-500">Live · actualiza cada 60s</span>
        </div>
      </div>

      {/* Account summary chips */}
      {account && (
        <div className="flex flex-wrap gap-3 mb-5">
          <div className="bg-gray-800/60 rounded-lg px-4 py-2 text-center">
            <p className="text-xs text-gray-500">Portfolio</p>
            <p className="text-base font-bold text-white font-mono">
              ${account.portfolio_value.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
            </p>
          </div>
          <div className="bg-gray-800/60 rounded-lg px-4 py-2 text-center">
            <p className="text-xs text-gray-500">Buying Power</p>
            <p className="text-base font-bold text-indigo-300 font-mono">
              ${account.buying_power.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
            </p>
          </div>
          <div className="bg-gray-800/60 rounded-lg px-4 py-2 text-center">
            <p className="text-xs text-gray-500">Cash</p>
            <p className="text-base font-bold text-gray-300 font-mono">
              ${account.cash.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
            </p>
          </div>
        </div>
      )}

      {loading && (
        <p className="text-center text-gray-500 py-8 animate-pulse">
          Consultando Alpaca…
        </p>
      )}

      {error && (
        <p className="text-center text-yellow-500/80 py-4 text-sm">
          ⚠️ {error}
        </p>
      )}

      {!loading && !error && positions.length === 0 && (
        <p className="text-center text-gray-600 py-8">
          No hay posiciones abiertas actualmente.
        </p>
      )}

      {positions.length > 0 && (
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-gray-800">
                <th className="text-left py-2 px-3 text-gray-500 font-medium">Ticker</th>
                <th className="text-left py-2 px-3 text-gray-500 font-medium">Lado</th>
                <th className="text-right py-2 px-3 text-gray-500 font-medium">Acciones</th>
                <th className="text-right py-2 px-3 text-gray-500 font-medium">Precio Entrada</th>
                <th className="text-right py-2 px-3 text-gray-500 font-medium">Precio Actual</th>
                <th className="text-right py-2 px-3 text-gray-500 font-medium">P&L No Realizado</th>
                <th className="text-right py-2 px-3 text-gray-500 font-medium">%</th>
                <th className="text-right py-2 px-3 text-gray-500 font-medium">Valor</th>
              </tr>
            </thead>
            <tbody>
              {positions.map((pos) => {
                const isGain = pos.unrealized_pl >= 0;
                const isLong = pos.side === "long";
                return (
                  <tr
                    key={pos.symbol}
                    className="border-b border-gray-800/50 hover:bg-gray-800/30 transition-colors"
                  >
                    <td className="py-3 px-3">
                      <span className="font-mono text-indigo-300 text-xs bg-indigo-900/30 px-2 py-0.5 rounded">
                        {pos.symbol}
                      </span>
                    </td>
                    <td className="py-3 px-3">
                      <span
                        className={`text-xs font-bold px-2 py-0.5 rounded ${
                          isLong
                            ? "bg-emerald-900/40 text-emerald-400"
                            : "bg-rose-900/40 text-rose-400"
                        }`}
                      >
                        {isLong ? "▲ LONG" : "▼ SHORT"}
                      </span>
                    </td>
                    <td className="py-3 px-3 text-right font-mono text-gray-200">
                      {pos.qty}
                    </td>
                    <td className="py-3 px-3 text-right font-mono text-gray-400">
                      ${pos.avg_entry_price.toFixed(2)}
                    </td>
                    <td className="py-3 px-3 text-right font-mono text-white">
                      ${pos.current_price.toFixed(2)}
                    </td>
                    <td className="py-3 px-3 text-right font-medium">
                      <span className={isGain ? "text-emerald-400" : "text-rose-400"}>
                        {isGain ? "+" : ""}${pos.unrealized_pl.toFixed(2)}
                      </span>
                    </td>
                    <td className="py-3 px-3 text-right font-medium">
                      <span className={isGain ? "text-emerald-400" : "text-rose-400"}>
                        {isGain ? "+" : ""}
                        {pos.unrealized_plpc.toFixed(2)}%
                      </span>
                    </td>
                    <td className="py-3 px-3 text-right font-mono text-gray-300">
                      ${pos.market_value.toFixed(2)}
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

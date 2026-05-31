"use client";

import { format, parseISO } from "date-fns";
import { Trade } from "../../lib/supabase";

interface Props {
  trades: Trade[];
  etfSymbols: Record<string, string>; // etf_id → symbol
}

export default function TradesTable({ trades, etfSymbols }: Props) {
  const sorted = [...trades].sort(
    (a, b) => new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime()
  );

  const totalPnL = trades.reduce((sum, t) => sum + (t.profit_loss ?? 0), 0);

  return (
    <div className="glass-card p-6 fade-in">
      <div className="flex items-center justify-between mb-5">
        <div>
          <span className="text-xs font-semibold text-indigo-400 uppercase tracking-widest">
            Historial de Operaciones
          </span>
          <h2 className="text-lg font-bold text-white mt-1">Trades</h2>
        </div>
        <div className="text-right">
          <p className="text-xs text-gray-500">P&amp;L Total</p>
          <p className={`text-xl font-bold ${totalPnL >= 0 ? "text-emerald-400" : "text-red-400"}`}>
            {totalPnL >= 0 ? "+" : ""}${totalPnL.toFixed(2)}
          </p>
        </div>
      </div>

      <div className="overflow-x-auto">
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b border-gray-800">
              <th className="text-left py-2 px-3 text-gray-500 font-medium">ETF</th>
              <th className="text-left py-2 px-3 text-gray-500 font-medium">Acción</th>
              <th className="text-right py-2 px-3 text-gray-500 font-medium">Precio</th>
              <th className="text-right py-2 px-3 text-gray-500 font-medium">Cantidad</th>
              <th className="text-right py-2 px-3 text-gray-500 font-medium">P&amp;L</th>
              <th className="text-right py-2 px-3 text-gray-500 font-medium">Fecha</th>
            </tr>
          </thead>
          <tbody>
            {sorted.length === 0 ? (
              <tr>
                <td colSpan={6} className="text-center py-12 text-gray-600">
                  No hay operaciones todavía. El bot está analizando el mercado…
                </td>
              </tr>
            ) : (
              sorted.map((trade) => (
                <tr
                  key={trade.id}
                  className="border-b border-gray-800/50 hover:bg-gray-800/30 transition-colors"
                >
                  <td className="py-3 px-3">
                    <span className="font-mono text-indigo-300 text-xs bg-indigo-900/30 px-2 py-0.5 rounded">
                      {etfSymbols[trade.etf_id] ?? "—"}
                    </span>
                  </td>
                  <td className="py-3 px-3">
                    <span
                      className={`text-xs font-bold px-2 py-0.5 rounded ${
                        trade.action.includes("BUY") || trade.action.includes("COVER")
                          ? "bg-emerald-900/40 text-emerald-400"
                          : "bg-red-900/40 text-red-400"
                      }`}
                    >
                      {trade.action}
                    </span>
                  </td>
                  <td className="py-3 px-3 text-right font-mono text-gray-200">
                    ${trade.price.toFixed(2)}
                  </td>
                  <td className="py-3 px-3 text-right text-gray-400">
                    {trade.quantity}
                  </td>
                  <td className="py-3 px-3 text-right font-medium">
                    {trade.profit_loss !== null ? (
                      <span className={trade.profit_loss >= 0 ? "text-emerald-400" : "text-red-400"}>
                        {trade.profit_loss >= 0 ? "+" : ""}${trade.profit_loss.toFixed(2)}
                      </span>
                    ) : (
                      <span className="text-gray-600">—</span>
                    )}
                  </td>
                  <td className="py-3 px-3 text-right text-gray-500 text-xs">
                    {format(parseISO(trade.timestamp), "dd/MM HH:mm")}
                  </td>
                </tr>
              ))
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}

"use client";

import { useEffect, useState } from "react";
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

interface EquityPoint {
  date: string;
  bot: number;
  spy: number | null;
}

interface MetricsData {
  sharpe: number | null;
  maxDrawdown: number | null;
  totalEquity: number | null;
  equityHistory: EquityPoint[];
  error?: string;
}

export default function EquityCurveChart() {
  const [data, setData] = useState<MetricsData | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    fetch("/api/metrics", { cache: "no-store" })
      .then((r) => r.json())
      .then((json) => setData(json))
      .catch(() => setData(null))
      .finally(() => setLoading(false));
  }, []);

  const history = data?.equityHistory ?? [];
  const hasSpy = history.some((p) => p.spy !== null);

  return (
    <div className="glass-card p-6 fade-in">
      <div className="flex items-start justify-between mb-6">
        <div>
          <span className="text-xs font-semibold text-indigo-400 uppercase tracking-widest">
            Rendimiento Histórico
          </span>
          <h2 className="text-lg font-bold text-white mt-1">
            Curva de Equity · Bot vs SPY
          </h2>
          <p className="text-xs text-gray-500 mt-1">
            Indexado a 100 desde el primer registro · Rf = 4%
          </p>
        </div>
      </div>

      {loading && (
        <div className="flex items-center justify-center h-56 text-gray-500 animate-pulse">
          Cargando datos históricos…
        </div>
      )}

      {!loading && history.length < 2 && (
        <div className="flex flex-col items-center justify-center h-56 gap-2 text-center">
          <span className="text-3xl">📈</span>
          <p className="text-gray-500 text-sm">
            La curva de equity se construye con el tiempo.
          </p>
          <p className="text-gray-600 text-xs">
            Vuelve después del próximo ciclo del worker para ver datos aquí.
          </p>
        </div>
      )}

      {!loading && history.length >= 2 && (
        <ResponsiveContainer width="100%" height={300}>
          <LineChart
            data={history}
            margin={{ top: 5, right: 10, left: -10, bottom: 0 }}
          >
            <CartesianGrid strokeDasharray="3 3" stroke="#1f2937" vertical={false} />
            <XAxis
              dataKey="date"
              tick={{ fill: "#6b7280", fontSize: 11 }}
              axisLine={false}
              tickLine={false}
              interval="preserveStartEnd"
            />
            <YAxis
              tick={{ fill: "#6b7280", fontSize: 11 }}
              axisLine={false}
              tickLine={false}
              tickFormatter={(v: number) => `${v.toFixed(0)}`}
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
                `${value.toFixed(2)}`,
                name === "bot" ? "🤖 Bot" : "📊 SPY",
              ]}
            />
            <Legend
              formatter={(value) => (value === "bot" ? "🤖 Bot Portfolio" : "📊 SPY Benchmark")}
              wrapperStyle={{ color: "#9ca3af", fontSize: "12px" }}
            />
            <ReferenceLine y={100} stroke="#374151" strokeDasharray="4 4" />
            <Line
              type="monotone"
              dataKey="bot"
              stroke="#6366f1"
              strokeWidth={2}
              dot={false}
              activeDot={{ r: 4, fill: "#8b5cf6" }}
            />
            {hasSpy && (
              <Line
                type="monotone"
                dataKey="spy"
                stroke="#10b981"
                strokeWidth={1.5}
                strokeDasharray="5 3"
                dot={false}
                activeDot={{ r: 3, fill: "#10b981" }}
              />
            )}
          </LineChart>
        </ResponsiveContainer>
      )}
    </div>
  );
}

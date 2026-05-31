"use client";

import { useEffect, useState } from "react";

interface MetricsData {
  sharpe: number | null;
  maxDrawdown: number | null;
  totalEquity: number | null;
}

function MetricCard({
  label,
  value,
  sub,
  color,
  icon,
}: {
  label: string;
  value: string;
  sub?: string;
  color: "indigo" | "emerald" | "yellow" | "rose";
  icon: string;
}) {
  const colorMap = {
    indigo: "text-indigo-400 border-indigo-500/20",
    emerald: "text-emerald-400 border-emerald-500/20",
    yellow: "text-yellow-400 border-yellow-500/20",
    rose: "text-rose-400 border-rose-500/20",
  };
  return (
    <div
      className={`glass-card p-5 border fade-in ${colorMap[color]}`}
    >
      <div className="flex items-center gap-2 mb-3">
        <span className="text-2xl">{icon}</span>
        <span className="text-xs text-gray-500 font-medium uppercase tracking-widest">
          {label}
        </span>
      </div>
      <p className={`text-3xl font-bold font-mono ${colorMap[color].split(" ")[0]}`}>
        {value}
      </p>
      {sub && <p className="text-xs text-gray-600 mt-1">{sub}</p>}
    </div>
  );
}

export default function MetricsKpiRow() {
  const [data, setData] = useState<MetricsData | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    fetch("/api/metrics", { cache: "no-store" })
      .then((r) => r.json())
      .then((json) => setData(json))
      .catch(() => setData(null))
      .finally(() => setLoading(false));
  }, []);

  if (loading) {
    return (
      <div className="grid grid-cols-1 md:grid-cols-3 gap-4 mb-6">
        {[1, 2, 3].map((i) => (
          <div key={i} className="glass-card p-5 animate-pulse h-28" />
        ))}
      </div>
    );
  }

  const equity = data?.totalEquity;
  const sharpe = data?.sharpe;
  const dd = data?.maxDrawdown;

  // Sharpe color logic
  const sharpeColor =
    sharpe === null
      ? "indigo"
      : sharpe >= 1
      ? "emerald"
      : sharpe >= 0
      ? "yellow"
      : "rose";

  return (
    <div className="grid grid-cols-1 md:grid-cols-3 gap-4 mb-6">
      <MetricCard
        label="Total Equity"
        icon="💼"
        value={
          equity !== null && equity !== undefined
            ? `$${equity.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`
            : "—"
        }
        sub="Valor actual de la cuenta Alpaca"
        color="indigo"
      />
      <MetricCard
        label="Sharpe Ratio"
        icon="📐"
        value={sharpe !== null && sharpe !== undefined ? sharpe.toFixed(2) : "—"}
        sub={`Rf = 4% anual · ${sharpe === null ? "Acumulando datos…" : sharpe >= 1 ? "✅ Excelente" : sharpe >= 0 ? "⚠️ Positivo" : "❌ Bajo benchmark"}`}
        color={sharpeColor}
      />
      <MetricCard
        label="Max Drawdown"
        icon="📉"
        value={dd !== null && dd !== undefined ? `-${dd.toFixed(2)}%` : "—"}
        sub="Caída máxima desde el pico histórico"
        color={dd === null ? "indigo" : dd > 15 ? "rose" : dd > 5 ? "yellow" : "emerald"}
      />
    </div>
  );
}

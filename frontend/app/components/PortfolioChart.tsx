"use client";

import { useEffect, useState } from "react";
import {
  AreaChart,
  Area,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  ResponsiveContainer,
} from "recharts";
import { format, parseISO } from "date-fns";
import { MarketIntelligence } from "../../lib/supabase";

interface Props {
  data: MarketIntelligence[];
  symbol: string;
}

export default function PortfolioChart({ data, symbol }: Props) {
  const chartData = [...data]
    .sort((a, b) => a.timestamp.localeCompare(b.timestamp))
    .slice(-60) // last 60 data points
    .map((d) => ({
      date: format(parseISO(d.timestamp), "dd MMM"),
      price: d.close_price,
      prob: d.prediction_prob ? Math.round(d.prediction_prob * 100) : null,
    }));

  const latestPrice = chartData.at(-1)?.price ?? 0;
  const prevPrice = chartData.at(-2)?.price ?? latestPrice;
  const change = latestPrice - prevPrice;
  const changePct = prevPrice ? (change / prevPrice) * 100 : 0;
  const isPositive = change >= 0;

  return (
    <div className="glass-card p-6 fade-in">
      {/* Header */}
      <div className="flex items-start justify-between mb-6">
        <div>
          <div className="flex items-center gap-2 mb-1">
            <span className="text-xs font-semibold text-indigo-400 uppercase tracking-widest">
              Precio de Cierre
            </span>
            <span className="flex items-center gap-1">
              <span className="pulse-dot w-2 h-2 rounded-full bg-emerald-400 inline-block" />
              <span className="text-xs text-gray-500">Live</span>
            </span>
          </div>
          <h2 className="text-3xl font-bold text-white">
            ${latestPrice.toFixed(2)}
          </h2>
          <span
            className={`text-sm font-medium ${isPositive ? "text-emerald-400" : "text-red-400"}`}
          >
            {isPositive ? "▲" : "▼"} {Math.abs(change).toFixed(2)} (
            {changePct.toFixed(2)}%)
          </span>
        </div>
        <span className="text-xs text-gray-500 bg-gray-800 px-3 py-1 rounded-full border border-gray-700">
          {symbol}
        </span>
      </div>

      {/* Chart */}
      <ResponsiveContainer width="100%" height={240}>
        <AreaChart data={chartData} margin={{ top: 0, right: 0, left: -20, bottom: 0 }}>
          <defs>
            <linearGradient id={`priceGrad-${symbol}`} x1="0" y1="0" x2="0" y2="1">
              <stop offset="5%" stopColor="#6366f1" stopOpacity={0.3} />
              <stop offset="95%" stopColor="#6366f1" stopOpacity={0} />
            </linearGradient>
          </defs>
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
            domain={["auto", "auto"]}
          />
          <Tooltip
            contentStyle={{
              backgroundColor: "#111827",
              border: "1px solid #374151",
              borderRadius: "0.5rem",
              color: "#f9fafb",
            }}
            formatter={(value: number) => [`$${value.toFixed(2)}`, "Precio"]}
          />
          <Area
            type="monotone"
            dataKey="price"
            stroke="#6366f1"
            strokeWidth={2}
            fill={`url(#priceGrad-${symbol})`}
            dot={false}
            activeDot={{ r: 4, fill: "#8b5cf6" }}
          />
        </AreaChart>
      </ResponsiveContainer>
    </div>
  );
}

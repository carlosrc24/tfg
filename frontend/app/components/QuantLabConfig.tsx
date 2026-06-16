"use client";

import { useState } from "react";

export interface QuantLabParams {
  start_date: string;
  end_date: string;
  initial_capital: number;
  atr_multiplier: number;
  trend_sma: number;
  min_holding_days: number;
  confirmation_days: number;
  alpha_factor: number;
  beta_factor: number;
  max_allocation_pct: number;
  take_profit_pct: number;
  sentiment_weight: number;
  investment_mode: "LUMP_SUM" | "PERIODIC";
  monthly_contribution: number;
}

interface Props {
  onRunStart: (runId: string) => void;
  isRunning: boolean;
}

const TODAY = new Date().toISOString().slice(0, 10);
const MIN_DATE = "2023-01-01";

const DEFAULTS: QuantLabParams = {
  start_date: "2023-01-01",
  end_date: TODAY,
  initial_capital: 100000,
  atr_multiplier: 2.5,
  trend_sma: 50,
  min_holding_days: 3,
  confirmation_days: 2,
  alpha_factor: 1.0,
  beta_factor: 1.0,
  max_allocation_pct: 0.20,
  take_profit_pct: 0.0,
  sentiment_weight: 0.0,
  investment_mode: "LUMP_SUM",
  monthly_contribution: 500,
};

// ── Reusable primitives ───────────────────────────────────────────────────────

function FieldLabel({ label, hint }: { label: string; hint?: string }) {
  return (
    <div className="mb-1">
      <span className="text-xs font-semibold text-gray-300 uppercase tracking-wider">
        {label}
      </span>
      {hint && <span className="text-xs text-gray-600 ml-2">{hint}</span>}
    </div>
  );
}

function SliderField({
  label,
  hint,
  min,
  max,
  step,
  value,
  format,
  onChange,
  disabled,
}: {
  label: string;
  hint?: string;
  min: number;
  max: number;
  step: number;
  value: number;
  format?: (v: number) => string;
  onChange: (v: number) => void;
  disabled: boolean;
}) {
  const fmt = format ?? ((v: number) => String(v));
  return (
    <div className="mb-4">
      <div className="flex justify-between items-center mb-1">
        <FieldLabel label={label} hint={hint} />
        <span className="text-sm font-mono font-bold text-indigo-300">
          {fmt(value)}
        </span>
      </div>
      <input
        type="range"
        min={min}
        max={max}
        step={step}
        value={value}
        disabled={disabled}
        onChange={(e) => onChange(Number(e.target.value))}
        className="w-full accent-indigo-500 disabled:opacity-40 cursor-pointer"
      />
      <div className="flex justify-between text-xs text-gray-600 mt-0.5">
        <span>{fmt(min)}</span>
        <span>{fmt(max)}</span>
      </div>
    </div>
  );
}

// ── Main component ────────────────────────────────────────────────────────────

export default function QuantLabConfig({ onRunStart, isRunning }: Props) {
  const [params, setParams] = useState<QuantLabParams>(DEFAULTS);
  const [error, setError] = useState<string | null>(null);

  function set<K extends keyof QuantLabParams>(key: K, value: QuantLabParams[K]) {
    setParams((p) => ({ ...p, [key]: value }));
  }

  async function handleExecute() {
    setError(null);
    try {
      const res = await fetch("/api/backtest/run", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(params),
      });
      const json = await res.json();
      if (!res.ok) throw new Error(json.error ?? "Unknown error");
      onRunStart(json.run_id as string);
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : "Failed to start backtest");
    }
  }

  const fmtUSD = (v: number) =>
    v >= 1_000 ? `$${(v / 1_000).toFixed(0)}k` : `$${v}`;
  const fmtX = (v: number) => `${v.toFixed(2)}×`;
  const fmtDays = (v: number) => `${v}d`;
  const fmtPct = (v: number) => `${Math.round(v * 100)}%`;
  const fmtWeight = (v: number) => v.toFixed(2);

  return (
    <div className="glass-card p-6 space-y-5">
      <div>
        <h3 className="text-sm font-bold text-white uppercase tracking-widest mb-0.5">
          Configuration
        </h3>
        <p className="text-xs text-gray-500">
          Customize parameters and launch an isolated backtest run.
        </p>
      </div>

      {/* ── Date range ─────────────────────────────────────────────────────── */}
      <div className="grid grid-cols-2 gap-3">
        <div>
          <FieldLabel label="Start Date" />
          <input
            type="date"
            min={MIN_DATE}
            max={params.end_date}
            value={params.start_date}
            disabled={isRunning}
            onChange={(e) => set("start_date", e.target.value)}
            className="w-full bg-gray-900 border border-gray-700 text-gray-200 text-sm rounded-lg px-3 py-2 focus:outline-none focus:border-indigo-500 disabled:opacity-40"
          />
        </div>
        <div>
          <FieldLabel label="End Date" />
          <input
            type="date"
            min={params.start_date}
            max={TODAY}
            value={params.end_date}
            disabled={isRunning}
            onChange={(e) => set("end_date", e.target.value)}
            className="w-full bg-gray-900 border border-gray-700 text-gray-200 text-sm rounded-lg px-3 py-2 focus:outline-none focus:border-indigo-500 disabled:opacity-40"
          />
        </div>
      </div>

      {/* ── Investment mode selector ───────────────────────────────────────── */}
      <div className="mb-4">
        <FieldLabel label="Estrategia de Inversión" />
        <div className="grid grid-cols-2 gap-2 mt-1">
          {(
            [
              { value: "LUMP_SUM", label: "Capital Inicial Único" },
              { value: "PERIODIC", label: "Aportaciones DCA" },
            ] as const
          ).map(({ value, label }) => (
            <button
              key={value}
              disabled={isRunning}
              onClick={() => {
                set("investment_mode", value);
                // Reset capital to a sensible default for the chosen mode
                set("initial_capital", value === "LUMP_SUM" ? 100_000 : 5_000);
              }}
              className={`py-2 text-xs font-semibold rounded-lg border transition-colors disabled:opacity-40 ${
                params.investment_mode === value
                  ? "bg-indigo-600 border-indigo-500 text-white"
                  : "bg-gray-900 border-gray-700 text-gray-400 hover:border-indigo-600"
              }`}
            >
              {label}
            </button>
          ))}
        </div>
      </div>

      {/* ── Capital (range adapts to selected mode) ────────────────────────── */}
      <SliderField
        label={
          params.investment_mode === "PERIODIC"
            ? "Capital Inicial (Pool de inicio)"
            : "Initial Capital"
        }
        hint={
          params.investment_mode === "PERIODIC"
            ? "$0 – $10k · pool de arranque"
            : "$5k – $150k"
        }
        min={params.investment_mode === "PERIODIC" ? 0 : 5_000}
        max={params.investment_mode === "PERIODIC" ? 10_000 : 150_000}
        step={params.investment_mode === "PERIODIC" ? 500 : 5_000}
        value={params.initial_capital}
        format={fmtUSD}
        onChange={(v) => set("initial_capital", v)}
        disabled={isRunning}
      />

      {/* ── Monthly contribution (DCA mode only) ───────────────────────────── */}
      {params.investment_mode === "PERIODIC" && (
        <SliderField
          label="Aportación Mensual"
          hint="inyectada cada 21 días hábiles"
          min={100}
          max={2_000}
          step={50}
          value={params.monthly_contribution}
          format={(v) => `$${v}`}
          onChange={(v) => set("monthly_contribution", v)}
          disabled={isRunning}
        />
      )}

      {/* ── Alpha factor ───────────────────────────────────────────────────── */}
      <SliderField
        label="Alpha Factor — AI Urgency"
        hint={`Buy at prob ≥ ${Math.min(Math.max(0.6 / params.alpha_factor, 0.35), 0.9).toFixed(2)}`}
        min={0.5}
        max={1.5}
        step={0.05}
        value={params.alpha_factor}
        format={fmtX}
        onChange={(v) => set("alpha_factor", v)}
        disabled={isRunning}
      />

      {/* ── Beta factor ────────────────────────────────────────────────────── */}
      <SliderField
        label="Beta Factor — Volatility Appetite"
        hint="scales order size by CAPM beta"
        min={0}
        max={2.0}
        step={0.1}
        value={params.beta_factor}
        format={fmtX}
        onChange={(v) => set("beta_factor", v)}
        disabled={isRunning}
      />

      {/* ── Sentiment weight ───────────────────────────────────────────────── */}
      <SliderField
        label="News Sentiment Weight — ω"
        hint={`p = ${(1 - params.sentiment_weight).toFixed(2)}·AI + ${params.sentiment_weight.toFixed(2)}·sentiment`}
        min={0.0}
        max={1.0}
        step={0.05}
        value={params.sentiment_weight}
        format={fmtWeight}
        onChange={(v) => set("sentiment_weight", v)}
        disabled={isRunning}
      />

      {/* ── ATR Multiplier ─────────────────────────────────────────────────── */}
      <SliderField
        label="ATR Multiplier — Trailing Stop"
        hint="trailing stop distance"
        min={1.5}
        max={5.0}
        step={0.1}
        value={params.atr_multiplier}
        format={fmtX}
        onChange={(v) => set("atr_multiplier", v)}
        disabled={isRunning}
      />

      {/* ── Max position allocation ────────────────────────────────────────── */}
      <SliderField
        label="Max Position Allocation"
        hint="capital cap per open position"
        min={0.10}
        max={0.50}
        step={0.05}
        value={params.max_allocation_pct}
        format={fmtPct}
        onChange={(v) => set("max_allocation_pct", v)}
        disabled={isRunning}
      />

      {/* ── Take profit target ─────────────────────────────────────────────── */}
      <SliderField
        label="Take Profit Target"
        hint={params.take_profit_pct === 0 ? "disabled" : "sell 50% when gain ≥ target"}
        min={0.0}
        max={0.50}
        step={0.05}
        value={params.take_profit_pct}
        format={(v) => v === 0 ? "Off" : fmtPct(v)}
        onChange={(v) => set("take_profit_pct", v)}
        disabled={isRunning}
      />

      {/* ── Min holding days ───────────────────────────────────────────────── */}
      <SliderField
        label="Min Holding Days — Time Lock"
        min={1}
        max={10}
        step={1}
        value={params.min_holding_days}
        format={fmtDays}
        onChange={(v) => set("min_holding_days", v)}
        disabled={isRunning}
      />

      {/* ── Confirmation days ──────────────────────────────────────────────── */}
      <SliderField
        label="Confirmation Days — Signal Window"
        min={1}
        max={5}
        step={1}
        value={params.confirmation_days}
        format={fmtDays}
        onChange={(v) => set("confirmation_days", v)}
        disabled={isRunning}
      />

      {/* ── SMA Trend Filter ───────────────────────────────────────────────── */}
      <div className="mb-4">
        <FieldLabel label="SMA Trend Engine Filter" hint="macro-regime baseline" />
        <div className="grid grid-cols-4 gap-2 mt-1">
          {[20, 50, 100, 200].map((sma) => (
            <button
              key={sma}
              disabled={isRunning}
              onClick={() => set("trend_sma", sma)}
              className={`py-2 text-sm font-mono font-semibold rounded-lg border transition-colors disabled:opacity-40 ${
                params.trend_sma === sma
                  ? "bg-indigo-600 border-indigo-500 text-white"
                  : "bg-gray-900 border-gray-700 text-gray-400 hover:border-indigo-600"
              }`}
            >
              SMA-{sma}
            </button>
          ))}
        </div>
      </div>

      {/* ── Error ──────────────────────────────────────────────────────────── */}
      {error && (
        <p className="text-xs text-rose-400 bg-rose-950/40 border border-rose-800/40 rounded-lg px-3 py-2">
          {error}
        </p>
      )}

      {/* ── Execute button ─────────────────────────────────────────────────── */}
      <button
        onClick={handleExecute}
        disabled={isRunning}
        className="w-full py-3 rounded-xl font-bold text-sm uppercase tracking-widest transition-all
          bg-indigo-600 hover:bg-indigo-500 text-white
          disabled:opacity-50 disabled:cursor-not-allowed disabled:bg-indigo-900
          shadow-lg shadow-indigo-900/40"
      >
        {isRunning ? (
          <span className="flex items-center justify-center gap-2">
            <svg className="animate-spin h-4 w-4" viewBox="0 0 24 24" fill="none">
              <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
              <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8v8H4z" />
            </svg>
            Running Backtest…
          </span>
        ) : (
          "Execute Backtest"
        )}
      </button>
    </div>
  );
}

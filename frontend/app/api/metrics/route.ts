import { NextResponse } from "next/server";
import { createClient } from "@supabase/supabase-js";

// Use service role key on the server for full access
const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL ?? "",
  process.env.SUPABASE_KEY ?? process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ?? ""
);

// 4% annual risk-free rate (US T-bill approximation)
const RISK_FREE_RATE_ANNUAL = 0.04;

interface EquityRow {
  timestamp: string;
  total_value: number;
  benchmark_value: number | null;
}

function calcSharpe(values: number[]): number | null {
  if (values.length < 2) return null;
  const returns: number[] = [];
  for (let i = 1; i < values.length; i++) {
    if (values[i - 1] > 0) returns.push((values[i] - values[i - 1]) / values[i - 1]);
  }
  if (returns.length === 0) return null;
  const mean = returns.reduce((s, r) => s + r, 0) / returns.length;
  const variance = returns.reduce((s, r) => s + (r - mean) ** 2, 0) / returns.length;
  const std = Math.sqrt(variance);
  if (std === 0) return null;
  const rfDaily = RISK_FREE_RATE_ANNUAL / 252;
  return Math.round(((mean - rfDaily) / std) * Math.sqrt(252) * 100) / 100;
}

function calcMaxDrawdown(values: number[]): number {
  let peak = values[0] ?? 0;
  let maxDD = 0;
  for (const v of values) {
    if (v > peak) peak = v;
    const dd = peak > 0 ? (peak - v) / peak : 0;
    if (dd > maxDD) maxDD = dd;
  }
  return Math.round(maxDD * 10000) / 100; // → %
}

function totalReturn(values: number[], initialCapital: number): number | null {
  if (values.length < 2 || initialCapital <= 0) return null;
  return Math.round(((values[values.length - 1] - initialCapital) / initialCapital) * 10000) / 100;
}

function calcCAGR(values: number[], initialCapital: number): number | null {
  if (values.length < 2 || initialCapital <= 0) return null;
  const years = values.length / 252;
  const end = values[values.length - 1];
  const cagr = Math.pow(end / initialCapital, 1 / years) - 1;
  return Math.round(cagr * 10000) / 100;
}

function calcAnnualizedVol(values: number[]): number | null {
  if (values.length < 2) return null;
  const returns: number[] = [];
  for (let i = 1; i < values.length; i++) {
    if (values[i - 1] > 0) returns.push((values[i] - values[i - 1]) / values[i - 1]);
  }
  if (returns.length === 0) return null;
  const mean = returns.reduce((s, r) => s + r, 0) / returns.length;
  const variance = returns.reduce((s, r) => s + (r - mean) ** 2, 0) / returns.length;
  return Math.round(Math.sqrt(variance) * Math.sqrt(252) * 10000) / 100; // → %
}

function calcSortino(values: number[]): number | null {
  if (values.length < 2) return null;
  const returns: number[] = [];
  for (let i = 1; i < values.length; i++) {
    if (values[i - 1] > 0) returns.push((values[i] - values[i - 1]) / values[i - 1]);
  }
  if (returns.length === 0) return null;
  const mean = returns.reduce((s, r) => s + r, 0) / returns.length;
  const rfDaily = RISK_FREE_RATE_ANNUAL / 252;
  const downsideVariance =
    returns.reduce((s, r) => s + Math.min(r - rfDaily, 0) ** 2, 0) / returns.length;
  const downsideStd = Math.sqrt(downsideVariance);
  if (downsideStd === 0) return null;
  return Math.round(((mean - rfDaily) / downsideStd) * Math.sqrt(252) * 100) / 100;
}

function calcCalmar(values: number[], initialCapital: number): number | null {
  const cagr = calcCAGR(values, initialCapital); // already in %
  const dd = calcMaxDrawdown(values); // already in %
  if (cagr === null || dd == null || dd === 0) return null;
  return Math.round((cagr / dd) * 100) / 100;
}

// Returns absolute USD chart data + SPY portfolio values for metric calculations.
// SPY buy-and-hold: spy_shares = initialCapital / first_spy_price, so both
// lines start at exactly $initialCapital on Day 1.
// Day-0 entries are pinned to initialCapital to guarantee identical origins
// regardless of floating-point precision.
function toAbsoluteDollars(
  rows: EquityRow[],
  initialCapital: number
): {
  chartData: { date: string; bot: number; spy: number | null }[];
  spyPortfolioValues: number[];
} {
  if (rows.length === 0) return { chartData: [], spyPortfolioValues: [] };

  const firstBenchRow = rows.find((r) => r.benchmark_value !== null && r.benchmark_value > 0);
  const firstSpyPrice = firstBenchRow?.benchmark_value ?? null;
  const spyShares = firstSpyPrice ? initialCapital / firstSpyPrice : null;

  const chartData = rows.map((r, i) => ({
    date: r.timestamp.slice(0, 10),
    // Pin the very first point to initialCapital so both lines share one origin
    bot: i === 0 ? initialCapital : r.total_value,
    spy:
      spyShares && r.benchmark_value
        ? i === 0
          ? initialCapital
          : Math.round(spyShares * r.benchmark_value * 100) / 100
        : null,
  }));

  // Second-pass dedup by date — eliminates any residual duplicates that could
  // cause the chart to render a thick ribbon/band artifact.
  const seenDates = new Set<string>();
  const uniqueChartData = chartData.filter((p) => {
    if (seenDates.has(p.date)) return false;
    seenDates.add(p.date);
    return true;
  });

  const spyPortfolioValues = spyShares
    ? rows.filter((r) => r.benchmark_value !== null).map((r) => spyShares * r.benchmark_value!)
    : [];

  return { chartData: uniqueChartData, spyPortfolioValues };
}

export async function GET(request: Request) {
  try {
    const { searchParams } = new URL(request.url);
    const mode = searchParams.get("mode") ?? "live"; // "live" | "backtest"
    const runId = searchParams.get("run_id");
    const isBacktest = mode === "backtest";

    let query = supabase
      .from("equity_history")
      .select("timestamp, total_value, benchmark_value")
      .eq("is_backtest", isBacktest)
      .order("timestamp", { ascending: true })
      .limit(5000);

    if (isBacktest && runId) {
      query = query.eq("run_id", runId);
    }

    const { data, error } = await query;

    if (error) throw new Error(error.message);

    // Deduplicate: keep exactly one row per calendar date (last upsert wins,
    // since the query is ordered ASC and we overwrite with each iteration).
    // This prevents multiple simulation runs from layering into a filled block.
    const rowsByDate = new Map<string, EquityRow>();
    for (const row of (data ?? []) as EquityRow[]) {
      rowsByDate.set(row.timestamp.slice(0, 10), row);
    }
    const rows = Array.from(rowsByDate.values()).sort((a, b) =>
      a.timestamp.localeCompare(b.timestamp)
    );

    const botValues = rows.map((r) => r.total_value);

    // Resolve initial capital — three-tier priority:
    //  1. backtest_runs table (accurate, when run_id is known)
    //  2. First row's total_value (Day 1 = no trades yet → equals initial_balance)
    //  3. Hard fallback $100k for truly empty datasets
    let initialCapital = 100_000;
    if (isBacktest) {
      if (runId) {
        const runResp = await supabase
          .from("backtest_runs")
          .select("parameters")
          .eq("id", runId)
          .maybeSingle();
        const cap = runResp.data?.parameters?.initial_capital;
        initialCapital = typeof cap === "number" && cap > 0 ? cap : 100_000;
      } else if (rows.length > 0 && rows[0].total_value > 0) {
        // No run_id: infer from first equity snapshot. Day 1 portfolio value
        // always equals initial_balance because trades only execute at D+1 open.
        initialCapital = rows[0].total_value;
      }
    }

    const { chartData: equityHistory, spyPortfolioValues } = toAbsoluteDollars(
      rows,
      initialCapital
    );

    const sharpe = calcSharpe(botValues);
    const spySharpe = spyPortfolioValues.length > 1 ? calcSharpe(spyPortfolioValues) : null;
    const maxDrawdown = botValues.length > 0 ? calcMaxDrawdown(botValues) : null;
    const spyMaxDrawdown =
      spyPortfolioValues.length > 1 ? calcMaxDrawdown(spyPortfolioValues) : null;
    const botReturn = botValues.length > 0 ? totalReturn(botValues, initialCapital) : null;
    const spyReturn =
      spyPortfolioValues.length > 1 ? totalReturn(spyPortfolioValues, initialCapital) : null;
    const botCagr = botValues.length > 0 ? calcCAGR(botValues, initialCapital) : null;
    const spyCagr =
      spyPortfolioValues.length > 1 ? calcCAGR(spyPortfolioValues, initialCapital) : null;
    const latestValue = botValues.length > 0 ? botValues[botValues.length - 1] : null;

    const annualizedVol = calcAnnualizedVol(botValues);
    const spyAnnualizedVol =
      spyPortfolioValues.length > 1 ? calcAnnualizedVol(spyPortfolioValues) : null;
    const sortinoRatio = calcSortino(botValues);
    const spySortinoRatio =
      spyPortfolioValues.length > 1 ? calcSortino(spyPortfolioValues) : null;
    const calmarRatio =
      botValues.length > 0 ? calcCalmar(botValues, initialCapital) : null;
    const spyCalmarRatio =
      spyPortfolioValues.length > 1 ? calcCalmar(spyPortfolioValues, initialCapital) : null;

    return NextResponse.json({
      mode,
      runId: runId ?? null,
      initialCapital,
      sharpe,
      spySharpe,
      maxDrawdown,
      spyMaxDrawdown,
      botReturn,
      spyReturn,
      botCagr,
      spyCagr,
      annualizedVol,
      spyAnnualizedVol,
      sortinoRatio,
      spySortinoRatio,
      calmarRatio,
      spyCalmarRatio,
      totalEquity: latestValue,
      equityHistory,
      dataPoints: rows.length,
    });
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : "Unknown error";
    return NextResponse.json(
      { error: message, sharpe: null, maxDrawdown: null, equityHistory: [] },
      { status: 200 }
    );
  }
}

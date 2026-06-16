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

// On DCA injection days (every 21 trading days), strip the cash deposit from the
// numerator so the deposit jump doesn't masquerade as a market gain in
// Sharpe / Sortino / Vol calculations.
function calcAdjustedReturns(
  values: number[],
  investmentMode: string,
  monthlyContribution: number
): number[] {
  if (values.length < 2) return [];
  const returns: number[] = [];
  for (let i = 1; i < values.length; i++) {
    if (values[i - 1] <= 0) continue;
    const deposit =
      investmentMode === "PERIODIC" && i % 21 === 0 ? monthlyContribution : 0;
    returns.push((values[i] - deposit - values[i - 1]) / values[i - 1]);
  }
  return returns;
}

function calcSharpeFromReturns(returns: number[]): number | null {
  if (returns.length === 0) return null;
  const mean = returns.reduce((s, r) => s + r, 0) / returns.length;
  const variance = returns.reduce((s, r) => s + (r - mean) ** 2, 0) / returns.length;
  const std = Math.sqrt(variance);
  if (std === 0) return null;
  const rfDaily = RISK_FREE_RATE_ANNUAL / 252;
  return Math.round(((mean - rfDaily) / std) * Math.sqrt(252) * 100) / 100;
}

function calcSortinoFromReturns(returns: number[]): number | null {
  if (returns.length === 0) return null;
  const mean = returns.reduce((s, r) => s + r, 0) / returns.length;
  const rfDaily = RISK_FREE_RATE_ANNUAL / 252;
  const downsideVariance =
    returns.reduce((s, r) => s + Math.min(r - rfDaily, 0) ** 2, 0) / returns.length;
  const downsideStd = Math.sqrt(downsideVariance);
  if (downsideStd === 0) return null;
  return Math.round(((mean - rfDaily) / downsideStd) * Math.sqrt(252) * 100) / 100;
}

function calcVolFromReturns(returns: number[]): number | null {
  if (returns.length === 0) return null;
  const mean = returns.reduce((s, r) => s + r, 0) / returns.length;
  const variance = returns.reduce((s, r) => s + (r - mean) ** 2, 0) / returns.length;
  return Math.round(Math.sqrt(variance) * Math.sqrt(252) * 10000) / 100; // → %
}

// Returns absolute USD chart data + SPY portfolio values for metric calculations.
// benchmark_value is stored by the engine as an absolute USD portfolio value
// (spy_accumulated_shares × spy_close) for both LUMP_SUM and PERIODIC modes,
// so no spy_shares reconstruction is needed here.
// Day-0 entries are pinned to initialCapital so both lines share one origin.
// In PERIODIC mode each point also carries `injected` = cumulative capital paid in.
function toAbsoluteDollars(
  rows: EquityRow[],
  initialCapital: number,
  investmentMode: string = "LUMP_SUM",
  monthlyContribution: number = 0
): {
  chartData: { date: string; bot: number; spy: number | null; injected: number | null }[];
  spyPortfolioValues: number[];
} {
  if (rows.length === 0) return { chartData: [], spyPortfolioValues: [] };

  const chartData = rows.map((r, i) => {
    const injected =
      investmentMode === "PERIODIC" && monthlyContribution > 0
        ? Math.round((initialCapital + Math.floor(i / 21) * monthlyContribution) * 100) / 100
        : null;
    return {
      date: r.timestamp.slice(0, 10),
      // Pin the very first point to initialCapital so both lines share one origin
      bot: i === 0 ? initialCapital : r.total_value,
      spy:
        r.benchmark_value !== null && r.benchmark_value > 0
          ? i === 0
            ? initialCapital
            : Math.round(r.benchmark_value * 100) / 100
          : null,
      injected,
    };
  });

  // Second-pass dedup by date — eliminates any residual duplicates that could
  // cause the chart to render a thick ribbon/band artifact.
  const seenDates = new Set<string>();
  const uniqueChartData = chartData.filter((p) => {
    if (seenDates.has(p.date)) return false;
    seenDates.add(p.date);
    return true;
  });

  const spyPortfolioValues = rows
    .filter((r) => r.benchmark_value !== null && r.benchmark_value > 0)
    .map((r) => r.benchmark_value!);

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

    // Resolve initial capital and DCA parameters — three-tier priority:
    //  1. backtest_runs table (accurate, when run_id is known)
    //  2. First row's total_value (Day 1 = no trades yet → equals initial_balance)
    //  3. Hard fallback $100k for truly empty datasets
    let initialCapital = 100_000;
    let investmentMode = "LUMP_SUM";
    let monthlyContribution = 0;
    if (isBacktest) {
      if (runId) {
        const runResp = await supabase
          .from("backtest_runs")
          .select("parameters")
          .eq("id", runId)
          .maybeSingle();
        const runParams = runResp.data?.parameters;
        const cap = runParams?.initial_capital;
        initialCapital = typeof cap === "number" && cap > 0 ? cap : 100_000;
        if (runParams?.investment_mode === "PERIODIC") {
          investmentMode = "PERIODIC";
          monthlyContribution =
            typeof runParams.monthly_contribution === "number"
              ? runParams.monthly_contribution
              : 0;
        }
      } else if (rows.length > 0 && rows[0].total_value > 0) {
        // No run_id: infer from first equity snapshot. Day 1 portfolio value
        // always equals initial_balance because trades only execute at D+1 open.
        initialCapital = rows[0].total_value;
      }
    }

    // Total capital actually paid in by the final simulation day.
    // Used as the cost-basis denominator for Total Return, CAGR, and Calmar.
    const totalInjectedFinal =
      investmentMode === "PERIODIC" && monthlyContribution > 0
        ? initialCapital +
          Math.floor((rows.length > 0 ? rows.length - 1 : 0) / 21) * monthlyContribution
        : initialCapital;

    const { chartData: equityHistory, spyPortfolioValues } = toAbsoluteDollars(
      rows,
      initialCapital,
      investmentMode,
      monthlyContribution
    );

    // Deposit-adjusted daily returns strip DCA injection days so cash deposits
    // don't masquerade as market gains in Sharpe / Sortino / Vol calculations.
    const botAdjReturns = calcAdjustedReturns(botValues, investmentMode, monthlyContribution);
    const spyAdjReturns = calcAdjustedReturns(
      spyPortfolioValues, investmentMode, monthlyContribution
    );

    const sharpe = calcSharpeFromReturns(botAdjReturns);
    const spySharpe = spyAdjReturns.length > 0 ? calcSharpeFromReturns(spyAdjReturns) : null;
    const maxDrawdown = botValues.length > 0 ? calcMaxDrawdown(botValues) : null;
    const spyMaxDrawdown =
      spyPortfolioValues.length > 1 ? calcMaxDrawdown(spyPortfolioValues) : null;
    const botReturn = botValues.length > 0 ? totalReturn(botValues, totalInjectedFinal) : null;
    const spyReturn =
      spyPortfolioValues.length > 1 ? totalReturn(spyPortfolioValues, totalInjectedFinal) : null;
    const botCagr = botValues.length > 0 ? calcCAGR(botValues, totalInjectedFinal) : null;
    const spyCagr =
      spyPortfolioValues.length > 1 ? calcCAGR(spyPortfolioValues, totalInjectedFinal) : null;
    const latestValue = botValues.length > 0 ? botValues[botValues.length - 1] : null;

    const annualizedVol = calcVolFromReturns(botAdjReturns);
    const spyAnnualizedVol =
      spyAdjReturns.length > 0 ? calcVolFromReturns(spyAdjReturns) : null;
    const sortinoRatio = calcSortinoFromReturns(botAdjReturns);
    const spySortinoRatio =
      spyAdjReturns.length > 0 ? calcSortinoFromReturns(spyAdjReturns) : null;
    const calmarRatio =
      botValues.length > 0 ? calcCalmar(botValues, totalInjectedFinal) : null;
    const spyCalmarRatio =
      spyPortfolioValues.length > 1 ? calcCalmar(spyPortfolioValues, totalInjectedFinal) : null;

    return NextResponse.json({
      mode,
      runId: runId ?? null,
      initialCapital,
      investmentMode,
      monthlyContribution,
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

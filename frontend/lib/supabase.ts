import { createClient } from "@supabase/supabase-js";

// Fallback to empty string during Docker build (build-time has no env vars).
// At runtime the real values are injected via docker-compose env_file.
const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL ?? "";
const supabaseAnonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ?? "";

export const supabase = createClient(supabaseUrl, supabaseAnonKey);

// ── Type definitions matching the DB schema ─────────────────────────────────

export type ETF = {
  id: string;
  symbol: string;
  name: string;
};

export type MarketIntelligence = {
  id: string;
  etf_id: string;
  timestamp: string;
  close_price: number;
  rsi: number | null;
  adx: number | null;
  sma_50: number | null;
  sma_200: number | null;
  atr: number | null;
  sentiment_score: number | null;
  prediction_prob: number | null;
};

export type Trade = {
  id: string;
  etf_id: string;
  timestamp: string;
  action: "BUY" | "SELL" | "SHORT" | "COVER" | "SELL_PARTIAL" | "SELL_FULL";
  price: number;
  quantity: number;
  profit_loss: number | null;
  is_backtest: boolean;
};

export type EquityHistory = {
  id: string;
  timestamp: string;
  total_value: number;
  benchmark_value: number | null;
  is_backtest: boolean;
};

"use client";

import { useEffect, useRef, useState } from "react";
import { createClient } from "@supabase/supabase-js";

const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL ?? "",
  process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ?? ""
);

type RunStatus = "queued" | "running" | "completed" | "failed";

interface RunState {
  status: RunStatus;
  progress_pct: number;
  terminal_logs: string;
}

interface Props {
  runId: string;
  onComplete?: () => void;
}

const STATUS_COLORS: Record<RunStatus, string> = {
  queued:    "text-yellow-400 bg-yellow-950/40 border-yellow-800/40",
  running:   "text-blue-400 bg-blue-950/40 border-blue-800/40",
  completed: "text-emerald-400 bg-emerald-950/40 border-emerald-800/40",
  failed:    "text-rose-400 bg-rose-950/40 border-rose-800/40",
};

const STATUS_LABELS: Record<RunStatus, string> = {
  queued:    "Queued",
  running:   "Running",
  completed: "Completed",
  failed:    "Failed",
};

export default function TerminalConsole({ runId, onComplete }: Props) {
  const [run, setRun] = useState<RunState>({
    status: "queued",
    progress_pct: 0,
    terminal_logs: "",
  });
  const logsEndRef = useRef<HTMLDivElement>(null);
  const completedRef = useRef(false);

  // ── Supabase Realtime subscription ────────────────────────────────────────
  useEffect(() => {
    completedRef.current = false;

    // Initial fetch
    supabase
      .from("backtest_runs")
      .select("status, progress_pct, terminal_logs")
      .eq("id", runId)
      .single()
      .then(({ data }) => {
        if (data) setRun(data as RunState);
      });

    const channel = supabase
      .channel(`run_${runId}`)
      .on(
        "postgres_changes",
        {
          event: "UPDATE",
          schema: "public",
          table: "backtest_runs",
          filter: `id=eq.${runId}`,
        },
        (payload) => {
          const updated = payload.new as RunState;
          setRun(updated);
          if (
            !completedRef.current &&
            (updated.status === "completed" || updated.status === "failed")
          ) {
            completedRef.current = true;
            onComplete?.();
          }
        }
      )
      .subscribe();

    return () => {
      supabase.removeChannel(channel);
    };
  }, [runId, onComplete]);

  // Auto-scroll terminal to bottom when new logs arrive
  useEffect(() => {
    logsEndRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [run.terminal_logs]);

  const pct = run.progress_pct ?? 0;
  const status = run.status ?? "queued";
  const isTerminal = status === "completed" || status === "failed";

  return (
    <div className="glass-card p-5 space-y-4 fade-in">
      {/* ── Header ─────────────────────────────────────────────────────────── */}
      <div className="flex items-center justify-between">
        <div>
          <h3 className="text-sm font-bold text-white uppercase tracking-widest">
            Terminal Output
          </h3>
          <p className="text-xs text-gray-600 font-mono mt-0.5">run/{runId.slice(0, 8)}…</p>
        </div>
        <span
          className={`text-xs font-bold px-2.5 py-1 rounded-full border ${STATUS_COLORS[status]}`}
        >
          {STATUS_LABELS[status]}
        </span>
      </div>

      {/* ── Progress bar ───────────────────────────────────────────────────── */}
      <div>
        <div className="flex justify-between text-xs text-gray-500 mb-1">
          <span>Progress</span>
          <span className="font-mono">{pct}%</span>
        </div>
        <div className="w-full bg-gray-800 rounded-full h-2 overflow-hidden">
          <div
            className={`h-2 rounded-full transition-all duration-500 ${
              status === "failed"
                ? "bg-rose-500"
                : status === "completed"
                ? "bg-emerald-500"
                : "bg-indigo-500"
            }`}
            style={{ width: `${pct}%` }}
          />
        </div>
      </div>

      {/* ── Terminal window ────────────────────────────────────────────────── */}
      <div
        className="bg-slate-950 border border-slate-800 rounded-xl p-4 h-72 overflow-y-auto font-mono text-xs text-slate-300 leading-relaxed"
        style={{ scrollBehavior: "smooth" }}
      >
        {run.terminal_logs ? (
          <>
            <pre className="whitespace-pre-wrap break-all">{run.terminal_logs}</pre>
            {!isTerminal && (
              <span className="inline-block w-2 h-3 bg-indigo-400 animate-pulse ml-0.5" />
            )}
          </>
        ) : (
          <span className="text-slate-600">
            {status === "queued" ? "Waiting for worker to pick up the job…" : "Initializing…"}
          </span>
        )}
        <div ref={logsEndRef} />
      </div>
    </div>
  );
}

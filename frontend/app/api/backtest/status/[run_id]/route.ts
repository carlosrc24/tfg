import { NextRequest, NextResponse } from "next/server";

const BACKEND_URL = process.env.BACKEND_API_URL ?? "http://backend:8000";

export async function GET(
  _req: NextRequest,
  { params }: { params: { run_id: string } }
) {
  try {
    const res = await fetch(
      `${BACKEND_URL}/api/backtest/status/${params.run_id}`,
      { cache: "no-store" }
    );
    const data = await res.json();
    return NextResponse.json(data, { status: res.status });
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : "Failed to reach backend";
    return NextResponse.json({ error: message }, { status: 502 });
  }
}

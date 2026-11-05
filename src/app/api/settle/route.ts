// POST /api/settle — a client saw a round end; run settlement now instead of waiting for the next cron tick.
// Anyone may call it: the edge function only settles rounds that are due, and settling is idempotent.
// Calls within 2s of the last one (per server instance) share that call.
import { NextResponse } from "next/server";

export const dynamic = "force-dynamic";

let last: { at: number; result: Promise<unknown> } | null = null;

async function runSettle() {
  const url = `${process.env.NEXT_PUBLIC_SUPABASE_URL}/functions/v1/settle`;
  const r = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json", "x-settle-secret": process.env.SETTLE_SECRET ?? "" },
    body: "{}",
    cache: "no-store",
  });
  return { status: r.status, body: await r.json().catch(() => null) };
}

export async function POST() {
  if (!process.env.SETTLE_SECRET) return NextResponse.json({ error: "SETTLE_SECRET is not set" }, { status: 500 });
  if (!last || Date.now() - last.at > 2_000) last = { at: Date.now(), result: runSettle() };
  try {
    return NextResponse.json(await last.result);
  } catch (e) {
    last = null;
    return NextResponse.json({ error: e instanceof Error ? e.message : "settle failed" }, { status: 502 });
  }
}

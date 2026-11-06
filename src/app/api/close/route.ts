// POST /api/close — sell an open position back to the pool at the server's bid (fair value minus the edge).
import { NextResponse } from "next/server";
import { parseClose, prepareClose, type ClosablePosition } from "@/lib/server/close";
import { serverSpot, serverVol } from "@/lib/server/market";
import { currentUserId, supabaseAdmin } from "@/lib/supabase/server";

export const dynamic = "force-dynamic";

const DB_ERRORS: Record<string, [number, string]> = {
  not_found: [404, "Position not found"],
  not_open: [409, "This position is no longer open"],
  settling: [409, "Settling… too late to close"],
  bad_proceeds: [400, "Couldn't price this close. Try again."],
};

export async function POST(request: Request) {
  const userId = await currentUserId();
  if (!userId) return NextResponse.json({ error: "signed_out", message: "Sign in with X first" }, { status: 401 });
  const input = parseClose(await request.json().catch(() => null));
  if (!input) return NextResponse.json({ error: "bad_request", message: "Invalid close" }, { status: 400 });

  const db = supabaseAdmin();
  const { data: pos, error: posErr } = await db
    .from("positions")
    .select("id,user_id,asset,side,strike,tenor,expiry,premium,units,payout_cap,status")
    .eq("id", input.positionId)
    .maybeSingle<ClosablePosition>();
  if (posErr) {
    console.error("close lookup failed", { userId, message: posErr.message });
    return NextResponse.json({ error: "server", message: "Something went wrong on our side. Try again." }, { status: 500 });
  }
  if (!pos) return NextResponse.json({ error: "not_found", message: "Position not found" }, { status: 404 });

  let spot: number, sigma: number;
  try {
    const [s, v] = await Promise.all([serverSpot(pos.asset), serverVol(pos.asset)]);
    spot = s.price;
    sigma = v.sigma;
  } catch (e) {
    return NextResponse.json({ error: "no_price", message: e instanceof Error ? e.message : "Price unavailable" }, { status: 503 });
  }

  const prepared = prepareClose(pos, input.bid, { spot, sigma }, userId, Date.now());
  if (!prepared.ok) {
    const { status, error, message, bid } = prepared;
    return NextResponse.json({ error, message, bid }, { status });
  }

  let data, error;
  try {
    ({ data, error } = await db.rpc("close_position", { p_user: userId, ...prepared.rpc }));
  } catch (e) {
    error = { message: e instanceof Error ? e.message : String(e) };
  }
  if (error) {
    console.error("close_position failed", { userId, message: error.message });
    return NextResponse.json({ error: "server", message: "Something went wrong on our side. Your position is still open." }, { status: 500 });
  }
  if (data?.error) {
    const [status, message] = DB_ERRORS[data.error] ?? [400, data.error];
    return NextResponse.json({ error: data.error, message }, { status });
  }
  return NextResponse.json({ ...data, bid: prepared.bid });
}

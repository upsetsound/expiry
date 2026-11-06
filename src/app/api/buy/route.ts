// POST /api/buy — price a trade on the server and record it atomically. The client's prices are never trusted:
// it only sends what it wants to buy and the premium per unit it was shown (for the 2% "price moved" check).
import { NextResponse } from "next/server";
import { DB_ERRORS, parseBuy, prepareBuy } from "@/lib/server/buy";
import { serverLimits } from "@/lib/server/limits";
import { serverSpot, serverVol } from "@/lib/server/market";
import { currentUserId, supabaseAdmin } from "@/lib/supabase/server";

export const dynamic = "force-dynamic";

export async function POST(request: Request) {
  const userId = await currentUserId();
  if (!userId) return NextResponse.json({ error: "signed_out", message: "Sign in to trade" }, { status: 401 });

  // Every trader needs a public name first: an X handle, or a username picked after Google sign-in.
  const { data: prof } = await supabaseAdmin().from("profiles").select("x_handle,username").eq("id", userId).maybeSingle();
  if (!prof?.x_handle && !prof?.username) return NextResponse.json({ error: "no_username", message: "Pick a username to trade" }, { status: 403 });

  const input = parseBuy(await request.json().catch(() => null));
  if (!input) return NextResponse.json({ error: "bad_request", message: "Invalid order" }, { status: 400 });

  let spot: number, sigma: number;
  const limits = await serverLimits();
  try {
    const [s, v] = await Promise.all([serverSpot(input.asset), serverVol(input.asset)]);
    spot = s.price;
    sigma = v.sigma;
  } catch (e) {
    return NextResponse.json({ error: "no_price", message: e instanceof Error ? e.message : "Price unavailable" }, { status: 503 });
  }

  const prepared = prepareBuy(input, { spot, sigma }, Date.now(), limits);
  if (!prepared.ok) {
    const { status, error, message, quote } = prepared;
    return NextResponse.json({ error, message, quote }, { status });
  }

  let data, error;
  try {
    ({ data, error } = await supabaseAdmin().rpc("buy_position", { p_user: userId, ...prepared.rpc }));
  } catch (e) {
    error = { message: e instanceof Error ? e.message : String(e) };
  }
  if (error) {
    console.error("buy_position failed", { userId, message: error.message });
    return NextResponse.json({ error: "server", message: "Something went wrong on our side. You weren't charged. Try again." }, { status: 500 });
  }
  if (data?.error) {
    const [status, fallback] = DB_ERRORS[data.error] ?? [400, data.error];
    let message = fallback;
    if (data.limit && data.error === "max_per_trade") message = `Max $${Number(data.limit).toLocaleString("en-US")} per trade`;
    if (data.limit && data.error === "max_per_expiry") message = `Max $${Number(data.limit).toLocaleString("en-US")} per round`;
    return NextResponse.json({ error: data.error, message, quote: prepared.quote }, { status });
  }
  return NextResponse.json({ ...data, quote: prepared.quote });
}

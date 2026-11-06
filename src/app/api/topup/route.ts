// POST /api/topup — weekly $10,000 top-up when the balance is under $1,000.
import { NextResponse } from "next/server";
import { currentUserId, supabaseAdmin } from "@/lib/supabase/server";

export const dynamic = "force-dynamic";

const MESSAGES: Record<string, string> = {
  balance_too_high: "Top-ups are for balances under $1,000",
  too_soon: "One top-up per week",
  no_profile: "Account not found — sign in again",
};

export async function POST() {
  const userId = await currentUserId();
  if (!userId) return NextResponse.json({ error: "signed_out", message: "Sign in first" }, { status: 401 });
  let data, error;
  try {
    ({ data, error } = await supabaseAdmin().rpc("topup", { p_user: userId }));
  } catch (e) {
    error = { message: e instanceof Error ? e.message : String(e) };
  }
  if (error) {
    console.error("topup failed", { userId, message: error.message });
    return NextResponse.json({ error: "server", message: "Something went wrong on our side. Try again." }, { status: 500 });
  }
  if (data?.error) return NextResponse.json({ ...data, message: MESSAGES[data.error] ?? data.error }, { status: 400 });
  return NextResponse.json(data);
}

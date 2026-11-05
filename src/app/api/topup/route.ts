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
  if (!userId) return NextResponse.json({ error: "signed_out", message: "Sign in with X first" }, { status: 401 });
  const { data, error } = await supabaseAdmin().rpc("topup", { p_user: userId });
  if (error) return NextResponse.json({ error: "db", message: error.message }, { status: 500 });
  if (data?.error) return NextResponse.json({ ...data, message: MESSAGES[data.error] ?? data.error }, { status: 400 });
  return NextResponse.json(data);
}

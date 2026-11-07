// POST /api/guest/discard — delete the caller's account, only if it's a guest. Used when a guest's "Save with X"
// finds that X account already has an Expiry account: we sign them into that one and drop the guest.
import { NextResponse } from "next/server";
import { supabaseAdmin, supabaseUser } from "@/lib/supabase/server";

export const dynamic = "force-dynamic";

export async function POST() {
  const { data } = await (await supabaseUser()).auth.getUser();
  const user = data.user;
  if (!user) return NextResponse.json({ ok: true });
  if (!user.is_anonymous) return NextResponse.json({ error: "not_guest", message: "Only guest accounts can be discarded" }, { status: 403 });
  const { error } = await supabaseAdmin().auth.admin.deleteUser(user.id);
  if (error) {
    console.error("guest discard failed", error.message);
    return NextResponse.json({ error: "failed", message: "Couldn't remove the guest account" }, { status: 500 });
  }
  return NextResponse.json({ ok: true });
}

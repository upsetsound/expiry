// X sign-in (and "Save with X" for guests) lands here with ?code=…; exchange it for a session cookie and go back to
// the app. If a guest tries to save with an X account that already has an Expiry account, Supabase refuses the link;
// send them back with ?link_existing=1 so the app signs them into that account instead.
import { NextResponse } from "next/server";
import { supabaseUser } from "@/lib/supabase/server";

export async function GET(request: Request) {
  const url = new URL(request.url);
  const code = url.searchParams.get("code");
  const linking = url.searchParams.get("link") === "1";
  const errorCode = url.searchParams.get("error_code") ?? "";
  const errorText = url.searchParams.get("error_description") ?? "";
  if (code) {
    const { error } = await (await supabaseUser()).auth.exchangeCodeForSession(code);
    if (error) return NextResponse.redirect(new URL(`/?auth_error=${encodeURIComponent(error.message)}`, url.origin));
    return NextResponse.redirect(new URL(linking ? "/?linked=1" : "/", url.origin));
  }
  if (linking && (errorCode === "identity_already_exists" || /already (linked|exists)/i.test(errorText))) {
    return NextResponse.redirect(new URL("/?link_existing=1", url.origin));
  }
  if (errorText) return NextResponse.redirect(new URL(`/?auth_error=${encodeURIComponent(errorText)}`, url.origin));
  return NextResponse.redirect(new URL("/", url.origin));
}

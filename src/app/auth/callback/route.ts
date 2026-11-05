// X sign-in lands here with ?code=…; exchange it for a session cookie and go back to the app.
import { NextResponse } from "next/server";
import { supabaseUser } from "@/lib/supabase/server";

export async function GET(request: Request) {
  const url = new URL(request.url);
  const code = url.searchParams.get("code");
  if (code) {
    const { error } = await (await supabaseUser()).auth.exchangeCodeForSession(code);
    if (error) return NextResponse.redirect(new URL(`/?auth_error=${encodeURIComponent(error.message)}`, url.origin));
  } else if (url.searchParams.get("error_description")) {
    return NextResponse.redirect(new URL(`/?auth_error=${encodeURIComponent(url.searchParams.get("error_description")!)}`, url.origin));
  }
  return NextResponse.redirect(new URL("/", url.origin));
}

// Server-side Supabase clients. `supabaseUser` acts as the signed-in user (cookie session);
// `supabaseAdmin` uses the service role and must only be used in route handlers.
import { createServerClient } from "@supabase/ssr";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { cookies } from "next/headers";

export async function supabaseUser(): Promise<SupabaseClient> {
  const store = await cookies();
  return createServerClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!, {
    cookies: {
      getAll: () => store.getAll(),
      setAll: (list) => {
        try {
          list.forEach(({ name, value, options }) => store.set(name, value, options));
        } catch {
          // Called from a context that can't set cookies; middleware refreshes the session instead.
        }
      },
    },
  });
}

let admin: SupabaseClient | null = null;
export function supabaseAdmin(): SupabaseClient {
  if (!admin) {
    const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
    if (!key) throw new Error("SUPABASE_SERVICE_ROLE_KEY is not set");
    // Keys go into HTTP headers, which only allow printable ASCII. A pasted comment or space breaks every call.
    if (!/^[\x21-\x7e]+$/.test(key)) throw new Error("SUPABASE_SERVICE_ROLE_KEY contains spaces or non-ASCII characters (a comment pasted after it?)");
    admin = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, key, { auth: { persistSession: false, autoRefreshToken: false } });
  }
  return admin;
}

// The verified user id for this request, or null. getUser() checks the token with Supabase Auth.
export async function currentUserId(): Promise<string | null> {
  const { data } = await (await supabaseUser()).auth.getUser();
  return data.user?.id ?? null;
}

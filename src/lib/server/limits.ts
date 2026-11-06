// Trade limits and the payout cap from the Supabase settings row, cached ~30s. Falls back to the code defaults.
import { DEFAULT_LIMITS, type Limits } from "@/lib/pricing";
import { supabaseAdmin } from "@/lib/supabase/server";

let cache: { at: number; value: Limits } | null = null;

export async function serverLimits(): Promise<Limits> {
  if (cache && Date.now() - cache.at < 30_000) return cache.value;
  try {
    const { data } = await supabaseAdmin().from("settings").select("max_premium_per_trade,max_premium_per_round,payout_cap").maybeSingle();
    const value: Limits = data
      ? { maxPerTrade: Number(data.max_premium_per_trade), maxPerRound: Number(data.max_premium_per_round), payoutCap: Number(data.payout_cap) }
      : DEFAULT_LIMITS;
    cache = { at: Date.now(), value };
    return value;
  } catch {
    return cache?.value ?? DEFAULT_LIMITS;
  }
}

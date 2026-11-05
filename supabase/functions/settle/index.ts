// settle: pays out every expired round. Triggered every 15s by pg_cron (via pg_net) and by POST /api/settle.
// Safe to run any number of times at once: settle_round writes each round's price once and only pays open positions.
import { createClient } from "npm:@supabase/supabase-js@2";
import { settlementPrice, type SettleAsset } from "../_shared/settlement.ts";

const SECRET = Deno.env.get("SETTLE_SECRET") ?? "";

Deno.serve(async (req) => {
  if (!SECRET || req.headers.get("x-settle-secret") !== SECRET) {
    return Response.json({ error: "unauthorized" }, { status: 401 });
  }
  const db = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!, {
    auth: { persistSession: false },
  });

  const { data: rounds, error } = await db.rpc("due_rounds");
  if (error) return Response.json({ error: error.message }, { status: 500 });

  const results = [];
  for (const r of rounds ?? []) {
    const expiry = Date.parse(r.expiry);
    // A round already priced (e.g. a late buy raced the first run) reuses its stored price.
    let price: number | null = r.settled_price;
    let source = "stored";
    let coverage: number | null = null;
    if (price === null) {
      const s = await settlementPrice(r.asset as SettleAsset, expiry, r.window_ms);
      if (!s) {
        results.push({ round: `${r.asset}-${r.tenor}-${r.expiry}`, error: "no_price" });
        continue; // try again on the next run
      }
      ({ price, source, coverage } = s);
    }
    const { data, error: e } = await db.rpc("settle_round", {
      p_asset: r.asset,
      p_tenor: r.tenor,
      p_expiry: r.expiry,
      p_price: price,
      p_window_ms: r.window_ms,
      p_source: source,
      p_coverage: coverage,
    });
    results.push({ round: `${r.asset}-${r.tenor}-${r.expiry}`, source, ...(e ? { error: e.message } : data) });
  }
  return Response.json({ ok: true, rounds: results.length, results });
});

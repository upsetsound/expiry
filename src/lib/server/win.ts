// A single settled winning position for the public /w/<id> share page and its OG image. Reads with the anon key:
// positions and handles are public.
import type { Tenor } from "@/lib/schedule";

export type Win = {
  id: string;
  asset: "BTC" | "ETH";
  side: "call" | "put";
  strike: number;
  tenor: Tenor;
  expiry: string;
  premium: number;
  payout: number;
  multiple: number;
  settle: number;
  handle: string | null;
  avatar: string | null;
};

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export async function getWin(id: string): Promise<Win | null> {
  if (!UUID.test(id)) return null;
  const base = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ?? "";
  try {
    const r = await fetch(
      `${base}/rest/v1/positions?id=eq.${id}&status=eq.settled&select=id,user_id,asset,side,strike,tenor,expiry,premium,payout,settle_price&limit=1`,
      { headers: { apikey: key }, next: { revalidate: 3600 } },
    );
    const [p] = (await r.json()) as Record<string, string | number>[];
    if (!p || Number(p.payout) <= Number(p.premium)) return null;
    const pr = await fetch(`${base}/rest/v1/profiles?id=eq.${p.user_id}&select=x_handle,avatar_url&limit=1`, {
      headers: { apikey: key },
      next: { revalidate: 3600 },
    });
    const [prof] = (await pr.json()) as { x_handle: string | null; avatar_url: string | null }[];
    const premium = Number(p.premium);
    const payout = Number(p.payout);
    return {
      id: String(p.id),
      asset: p.asset as Win["asset"],
      side: p.side as Win["side"],
      strike: Number(p.strike),
      tenor: p.tenor as Tenor,
      expiry: String(p.expiry),
      premium,
      payout,
      multiple: payout / premium,
      settle: Number(p.settle_price),
      handle: prof?.x_handle ?? null,
      avatar: prof?.avatar_url ?? null,
    };
  } catch {
    return null;
  }
}

export const winHeadline = (w: Win) =>
  `+${w.payout.toLocaleString("en-US", { style: "currency", currency: "USD" })} · ${w.multiple < 10 ? w.multiple.toFixed(1) : Math.round(w.multiple)}×`;
export const winDetail = (w: Win) => `${w.tenor} ${w.asset} ${w.side}${w.handle ? ` · @${w.handle}` : ""}`;

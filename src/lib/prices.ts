// Price helpers shared by the browser (feeds.ts) and the server (/api/buy). No React, no browser-only APIs.
export { fetchSeconds, settlementPrice, type Point } from "../../supabase/functions/_shared/settlement";

export type Asset = "BTC" | "ETH";
export const ASSETS: Asset[] = ["BTC", "ETH"];
export const TICK: Record<Asset, number> = { BTC: 10, ETH: 0.5 };

export type Venue = "coinbase" | "binance" | "okx" | "hyperliquid";
export const VENUES: Venue[] = ["coinbase", "binance", "okx", "hyperliquid"];
export type Quote = { price: number; at: number };

export const STALE_MS = 10_000;
const OUTLIER = 0.005;

function median(xs: number[]): number {
  const s = [...xs].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

// Median across fresh venues, dropping any venue more than 0.5% from the median of the others.
export function combine(book: Partial<Record<Venue, Quote>>, now: number): { price: number | null; n: number } {
  const fresh = Object.values(book).filter((q): q is Quote => !!q && now - q.at < STALE_MS).map((q) => q.price);
  if (fresh.length === 0) return { price: null, n: 0 };
  if (fresh.length < 3) return { price: median(fresh), n: fresh.length };
  const kept = fresh.filter((p, i) => Math.abs(p / median(fresh.filter((_, j) => j !== i)) - 1) <= OUTLIER);
  const use = kept.length ? kept : fresh;
  return { price: median(use), n: use.length };
}

// Only servers send a User-Agent; in a browser it would trigger a CORS preflight.
const UA: Record<string, string> = typeof window === "undefined" ? { "User-Agent": "expiry-paper/0.5" } : {};
const timeout = (ms: number) => AbortSignal.timeout(ms);

// One REST spot price per venue (the server's equivalent of the websocket feeds).
export async function fetchVenuePrice(venue: Venue, asset: Asset, ms = 2500): Promise<number> {
  const get = async (url: string, init?: RequestInit) => {
    const r = await fetch(url, { ...init, headers: { ...UA, ...(init?.headers ?? {}) }, signal: timeout(ms), cache: "no-store" });
    if (!r.ok) throw new Error(`${venue} ${r.status}`);
    return r.json();
  };
  let p: number;
  if (venue === "coinbase") p = parseFloat((await get(`https://api.exchange.coinbase.com/products/${asset}-USD/ticker`)).price);
  else if (venue === "binance") p = parseFloat((await get(`https://data-api.binance.vision/api/v3/ticker/price?symbol=${asset}USDT`)).price);
  else if (venue === "okx") p = parseFloat((await get(`https://www.okx.com/api/v5/market/ticker?instId=${asset}-USDT`)).data?.[0]?.last);
  else
    p = parseFloat(
      (await get("https://api.hyperliquid.xyz/info", { method: "POST", headers: { "Content-Type": "application/json" }, body: '{"type":"allMids"}' }))[asset],
    );
  if (!Number.isFinite(p) || p <= 0) throw new Error(`${venue} bad price`);
  return p;
}

// Latest Deribit DVOL (annualized implied vol) as a decimal, or null.
export async function fetchDvol(asset: Asset): Promise<number | null> {
  const end = Date.now();
  const start = end - 2 * 60 * 60_000;
  const r = await fetch(
    `https://www.deribit.com/api/v2/public/get_volatility_index_data?currency=${asset}&start_timestamp=${start}&end_timestamp=${end}&resolution=60`,
    { headers: UA, cache: "no-store" },
  );
  const j = await r.json();
  const data: number[][] = j?.result?.data ?? [];
  return data.length ? data[data.length - 1][4] / 100 : null;
}

// Coinbase 1-minute candles, oldest first, each stamped at the end of its minute.
export async function fetchCoinbaseHistory(asset: Asset): Promise<{ t: number; p: number }[]> {
  const r = await fetch(`https://api.exchange.coinbase.com/products/${asset}-USD/candles?granularity=60`, { headers: UA, cache: "no-store" });
  const rows: number[][] = await r.json();
  return rows.map((row) => ({ t: row[0] * 1000 + 60_000, p: row[4] })).sort((a, b) => a.t - b.t);
}

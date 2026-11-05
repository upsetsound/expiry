// Server-side market data for pricing buys. Spot is fetched fresh (cached 1s); sigma is cached about 30s.
import { VENUES, combine, fetchCoinbaseHistory, fetchDvol, fetchVenuePrice, type Asset, type Quote, type Venue } from "@/lib/prices";
import { pricingVol, realizedVol } from "@/lib/pricing";

const SPOT_TTL = 1_000;
const VOL_TTL = 30_000;

export type ServerSpot = { price: number; venues: number; failed: Venue[] };
export type ServerVol = { sigma: number; implied: number | null; realized: number };

const spotCache = new Map<Asset, { at: number; value: Promise<ServerSpot> }>();
const volCache = new Map<Asset, { at: number; value: Promise<ServerVol> }>();

// Median of Coinbase, Binance, OKX and Hyperliquid REST prices, dropping any venue >0.5% from the others.
// Needs at least 2 venues.
async function loadSpot(asset: Asset): Promise<ServerSpot> {
  const now = Date.now();
  const results = await Promise.allSettled(VENUES.map((v) => fetchVenuePrice(v, asset)));
  const book: Partial<Record<Venue, Quote>> = {};
  const failed: Venue[] = [];
  results.forEach((r, i) => {
    if (r.status === "fulfilled") book[VENUES[i]] = { price: r.value, at: now };
    else failed.push(VENUES[i]);
  });
  const c = combine(book, now);
  if (c.price === null || c.n < 2) throw new Error(`Not enough price feeds (${4 - failed.length}/4)`);
  return { price: c.price, venues: c.n, failed };
}

// sigma = max(Deribit DVOL, 1.25 x realized vol of the last 60 one-minute closes, 35%) — the client's rule,
// from the same sources the client seeds from (Deribit, Coinbase 1-minute candles).
async function loadVol(asset: Asset): Promise<ServerVol> {
  const [dvol, hist] = await Promise.allSettled([fetchDvol(asset), fetchCoinbaseHistory(asset)]);
  const implied = dvol.status === "fulfilled" ? dvol.value : null;
  const closes = hist.status === "fulfilled" ? hist.value.slice(-61).map((x) => x.p) : [];
  const realized = realizedVol(closes);
  return { sigma: pricingVol(implied, realized), implied, realized };
}

function cached<T>(map: Map<Asset, { at: number; value: Promise<T> }>, asset: Asset, ttl: number, load: (a: Asset) => Promise<T>) {
  const hit = map.get(asset);
  if (hit && Date.now() - hit.at < ttl) return hit.value;
  const value = load(asset);
  map.set(asset, { at: Date.now(), value });
  value.catch(() => map.delete(asset));
  return value;
}

export const serverSpot = (asset: Asset) => cached(spotCache, asset, SPOT_TTL, loadSpot);
export const serverVol = (asset: Asset) => cached(volCache, asset, VOL_TTL, loadVol);

// Settlement price for one round. Shared by the `settle` edge function (Deno) and the app (demo-mode settlement,
// tab backfill), so this file must stay dependency-free: plain TypeScript, global fetch only.

export type SettleAsset = "BTC" | "ETH";
export type Point = { t: number; p: number };
export type SettlementResult = { price: number; source: "binance-1s" | "coinbase-1m"; coverage: number };

export const MIN_COVERAGE = 0.6;
// Only servers send a User-Agent; in a browser it would trigger a CORS preflight.
const UA: Record<string, string> = typeof window === "undefined" ? { "User-Agent": "expiry-paper/0.5" } : {};

// Second-by-second closes from Binance's public market-data API (1,000 seconds per request), oldest first.
// Each point is the 1-second close stamped at the END of its second. Empty on failure.
export async function fetchSeconds(asset: SettleAsset, from: number, to: number, maxPoints = 7300): Promise<Point[]> {
  const out: Point[] = [];
  let start = Math.floor(from / 1000) * 1000;
  try {
    while (start < to && out.length < maxPoints) {
      const r = await fetch(
        `https://data-api.binance.vision/api/v3/klines?symbol=${asset}USDT&interval=1s&startTime=${start}&endTime=${to}&limit=1000`,
        { headers: UA },
      );
      if (!r.ok) break;
      const rows: (string | number)[][] = await r.json();
      if (!Array.isArray(rows) || !rows.length) break;
      for (const row of rows) {
        const t = Number(row[0]) + 1000;
        const p = parseFloat(String(row[4]));
        if (t <= to && Number.isFinite(p)) out.push({ t, p });
      }
      const next = Number(rows[rows.length - 1][0]) + 1000;
      if (next <= start) break;
      start = next;
    }
  } catch {
    // network error: return what we have
  }
  return out;
}

// Average of the 1-second closes inside (from, to]; coverage = share of the window's seconds present.
export function averageSeconds(points: Point[], from: number, to: number): { price: number | null; coverage: number } {
  const inWindow = points.filter((x) => x.t > from && x.t <= to);
  const seconds = Math.max(1, Math.round((to - from) / 1000));
  if (!inWindow.length) return { price: null, coverage: 0 };
  return { price: inWindow.reduce((a, x) => a + x.p, 0) / inWindow.length, coverage: Math.min(1, inWindow.length / seconds) };
}

// Coinbase 1-minute candles (newest first from the API). Windows of a minute or more average the closes inside;
// shorter windows use the close of the minute ending at expiry.
export function averageMinutes(rows: number[][], from: number, to: number): number | null {
  const start = Math.min(from, to - 60_000);
  const closes = rows
    .filter((row) => row[0] * 1000 >= start && row[0] * 1000 < to)
    .sort((a, b) => b[0] - a[0])
    .map((row) => row[4]);
  if (!closes.length) return null;
  return to - from >= 60_000 ? closes.reduce((a, b) => a + b, 0) / closes.length : closes[0];
}

export async function fetchCoinbaseMinutes(asset: SettleAsset, from: number, to: number): Promise<number[][]> {
  const start = Math.min(from, to - 60_000);
  try {
    const r = await fetch(
      `https://api.exchange.coinbase.com/products/${asset}-USD/candles?granularity=60&start=${new Date(start).toISOString()}&end=${new Date(to).toISOString()}`,
      { headers: UA },
    );
    if (!r.ok) return [];
    const rows = await r.json();
    return Array.isArray(rows) ? rows : [];
  } catch {
    return [];
  }
}

// The settlement rule: average of Binance 1-second closes over [expiry - window, expiry]; if fewer than 60% of
// those seconds are available, fall back to Coinbase 1-minute candles. Null if neither source has data.
export async function settlementPrice(asset: SettleAsset, expiry: number, windowMs: number): Promise<SettlementResult | null> {
  const from = expiry - windowMs;
  const secs = averageSeconds(await fetchSeconds(asset, from, expiry), from, expiry);
  if (secs.price !== null && secs.coverage >= MIN_COVERAGE) return { price: secs.price, source: "binance-1s", coverage: secs.coverage };
  const minute = averageMinutes(await fetchCoinbaseMinutes(asset, from, expiry), from, expiry);
  if (minute !== null) return { price: minute, source: "coinbase-1m", coverage: secs.coverage };
  return null;
}

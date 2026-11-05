"use client";
// Live prices from four venues, combined into one median price per asset, sampled 4 times a second.
import { useEffect, useRef, useState, type MutableRefObject } from "react";
import { realizedVol } from "./pricing";

export type Asset = "BTC" | "ETH";
export const ASSETS: Asset[] = ["BTC", "ETH"];
export const TICK: Record<Asset, number> = { BTC: 10, ETH: 0.5 };
export const SAMPLE_MS = 250;

type Venue = "coinbase" | "binance" | "okx" | "hyperliquid";
type Quote = { price: number; at: number };
type VenueBook = Record<Asset, Partial<Record<Venue, Quote>>>;

export type Sample = { t: number; p: number };
export type Series = Record<Asset, Sample[]>;

export type MarketState = {
  price: Record<Asset, number | null>;
  venues: Record<Asset, number>;
  realized: Record<Asset, number>;
  implied: Record<Asset, number | null>;
  open24: Record<Asset, number | null>;
  connected: boolean;
  samples: MutableRefObject<Series>; // live medians, mutated in place; read on each chart frame
  history: MutableRefObject<Series>; // 1-minute closes from before the page opened
};

export const isDemo = () => typeof window !== "undefined" && new URLSearchParams(window.location.search).has("demo");

const STALE_MS = 10_000;
const OUTLIER = 0.005;
const KEEP_MS = 2 * 60 * 60_000;

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

function openSocket(url: string, onOpen: (ws: WebSocket) => void, onMsg: (data: unknown) => void, pingText?: string) {
  let ws: WebSocket | null = null;
  let closed = false;
  let ping: ReturnType<typeof setInterval> | null = null;
  const connect = () => {
    try {
      ws = new WebSocket(url);
    } catch {
      setTimeout(connect, 5000);
      return;
    }
    ws.onopen = () => {
      onOpen(ws!);
      if (pingText) ping = setInterval(() => ws?.readyState === 1 && ws.send(pingText), 20_000);
    };
    ws.onmessage = (e) => {
      if (typeof e.data !== "string" || e.data === "pong") return;
      try {
        onMsg(JSON.parse(e.data));
      } catch {}
    };
    ws.onclose = () => {
      if (ping) clearInterval(ping);
      if (!closed) setTimeout(connect, 3000);
    };
    ws.onerror = () => ws?.close();
  };
  connect();
  return () => {
    closed = true;
    if (ping) clearInterval(ping);
    ws?.close();
  };
}

async function fetchCoinbaseHistory(asset: Asset): Promise<Sample[]> {
  const r = await fetch(`https://api.exchange.coinbase.com/products/${asset}-USD/candles?granularity=60`);
  const rows: number[][] = await r.json();
  return rows.map((row) => ({ t: row[0] * 1000 + 60_000, p: row[4] })).sort((a, b) => a.t - b.t);
}

async function fetchDvol(asset: Asset): Promise<number | null> {
  const end = Date.now();
  const start = end - 2 * 60 * 60_000;
  const r = await fetch(
    `https://www.deribit.com/api/v2/public/get_volatility_index_data?currency=${asset}&start_timestamp=${start}&end_timestamp=${end}&resolution=60`,
  );
  const j = await r.json();
  const data: number[][] = j?.result?.data ?? [];
  return data.length ? data[data.length - 1][4] / 100 : null;
}

// Fallback settlement when the tab was closed during the window: Coinbase 1-minute candles.
// Windows of a minute or more average the closes inside; shorter windows use the close of the minute ending at expiry.
export async function fetchSettlementFallback(asset: Asset, from: number, to: number): Promise<number | null> {
  try {
    const start = Math.min(from, to - 60_000);
    const r = await fetch(
      `https://api.exchange.coinbase.com/products/${asset}-USD/candles?granularity=60&start=${new Date(start).toISOString()}&end=${new Date(to).toISOString()}`,
    );
    const rows: number[][] = await r.json();
    const closes = rows.filter((row) => row[0] * 1000 >= start && row[0] * 1000 < to).map((row) => row[4]);
    if (!closes.length) return null;
    return to - from >= 60_000 ? closes.reduce((a, b) => a + b, 0) / closes.length : closes[0];
  } catch {
    return null;
  }
}

// Settlement: average of the sampled medians in [from, to). coverage = share of the window with samples.
export function twap(samples: Sample[], from: number, to: number): { price: number | null; coverage: number } {
  let lo = 0;
  let hi = samples.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (samples[mid].t < from) lo = mid + 1;
    else hi = mid;
  }
  let sum = 0;
  let n = 0;
  for (let i = lo; i < samples.length && samples[i].t < to; i++) {
    sum += samples[i].p;
    n++;
  }
  return n ? { price: sum / n, coverage: Math.min(1, (n * SAMPLE_MS) / (to - from)) } : { price: null, coverage: 0 };
}

export function useMarket(): MarketState {
  const book = useRef<VenueBook>({ BTC: {}, ETH: {} });
  const samples = useRef<Series>({ BTC: [], ETH: [] });
  const history = useRef<Series>({ BTC: [], ETH: [] });
  const closes = useRef<Record<Asset, number[]>>({ BTC: [], ETH: [] });
  const implied = useRef<Record<Asset, number | null>>({ BTC: null, ETH: null });
  const open24 = useRef<Record<Asset, number | null>>({ BTC: null, ETH: null });
  const lastMinute = useRef(0);
  const [state, setState] = useState<MarketState>({
    price: { BTC: null, ETH: null },
    venues: { BTC: 0, ETH: 0 },
    realized: { BTC: 0, ETH: 0 },
    implied: { BTC: null, ETH: null },
    open24: { BTC: null, ETH: null },
    connected: false,
    samples,
    history,
  });

  useEffect(() => {
    const demo = isDemo();
    const cleanups: (() => void)[] = [];

    if (demo) {
      // Simulated tick stream: the price holds, then jumps, like a real order book mid.
      const walk: Record<Asset, number> = { BTC: 101_250, ETH: 3_420 };
      const t0 = Date.now();
      for (const a of ASSETS) {
        let p = walk[a] * 0.997;
        const h: Sample[] = [];
        for (let i = 300; i > 0; i--) {
          p *= Math.exp((Math.random() - 0.49) * 0.0014);
          h.push({ t: Math.floor(t0 / 60_000) * 60_000 - i * 60_000, p });
        }
        history.current[a] = h;
        closes.current[a] = h.slice(-61).map((x) => x.p);
        walk[a] = p;
        open24.current[a] = p * 1.009;
      }
      implied.current = { BTC: 0.46, ETH: 0.58 };
      const id = setInterval(() => {
        for (const a of ASSETS) {
          if (Math.random() < 0.45) walk[a] *= Math.exp((Math.random() - 0.5) * 0.00022);
          book.current[a] = { coinbase: { price: walk[a], at: Date.now() } };
        }
      }, SAMPLE_MS);
      cleanups.push(() => clearInterval(id));
    } else {
      const set = (a: Asset, v: Venue, price: number) => {
        if (Number.isFinite(price) && price > 0) book.current[a][v] = { price, at: Date.now() };
      };
      const assetOf = (s: string): Asset | null => (s.startsWith("BTC") ? "BTC" : s.startsWith("ETH") ? "ETH" : null);
      cleanups.push(
        openSocket(
          "wss://ws-feed.exchange.coinbase.com",
          (ws) => ws.send(JSON.stringify({ type: "subscribe", product_ids: ["BTC-USD", "ETH-USD"], channels: ["ticker"] })),
          (d) => {
            const m = d as { type?: string; product_id?: string; price?: string };
            const a = m.product_id ? assetOf(m.product_id) : null;
            if (m.type === "ticker" && a && m.price) set(a, "coinbase", parseFloat(m.price));
          },
        ),
        openSocket(
          "wss://data-stream.binance.vision/stream?streams=btcusdt@trade/ethusdt@trade",
          () => {},
          (d) => {
            const m = d as { data?: { s?: string; p?: string } };
            const a = m.data?.s ? assetOf(m.data.s) : null;
            if (a && m.data?.p) set(a, "binance", parseFloat(m.data.p));
          },
        ),
        openSocket(
          "wss://ws.okx.com:8443/ws/v5/public",
          (ws) =>
            ws.send(
              JSON.stringify({
                op: "subscribe",
                args: [
                  { channel: "tickers", instId: "BTC-USDT" },
                  { channel: "tickers", instId: "ETH-USDT" },
                ],
              }),
            ),
          (d) => {
            const m = d as { arg?: { instId?: string }; data?: { last?: string }[] };
            const a = m.arg?.instId ? assetOf(m.arg.instId) : null;
            const last = m.data?.[0]?.last;
            if (a && last) set(a, "okx", parseFloat(last));
          },
          "ping",
        ),
        openSocket(
          "wss://api.hyperliquid.xyz/ws",
          (ws) => ws.send(JSON.stringify({ method: "subscribe", subscription: { type: "allMids" } })),
          (d) => {
            const m = d as { channel?: string; data?: { mids?: Record<string, string> } };
            if (m.channel !== "allMids" || !m.data?.mids) return;
            if (m.data.mids.BTC) set("BTC", "hyperliquid", parseFloat(m.data.mids.BTC));
            if (m.data.mids.ETH) set("ETH", "hyperliquid", parseFloat(m.data.mids.ETH));
          },
        ),
      );
      for (const a of ASSETS) {
        fetchCoinbaseHistory(a)
          .then((h) => {
            history.current[a] = h;
            closes.current[a] = h.slice(-61).map((x) => x.p);
          })
          .catch(() => {});
      }
      const slow = () => {
        for (const a of ASSETS) {
          fetchDvol(a)
            .then((v) => (implied.current[a] = v))
            .catch(() => {});
          fetch(`https://api.exchange.coinbase.com/products/${a}-USD/stats`)
            .then((r) => r.json())
            .then((j) => {
              const o = parseFloat(j?.open);
              if (Number.isFinite(o) && o > 0) open24.current[a] = o;
            })
            .catch(() => {});
        }
      };
      slow();
      const id = setInterval(slow, 60_000);
      cleanups.push(() => clearInterval(id));
    }

    // Sample 4x a second: combine venues, append to the series, roll 1-minute closes, publish.
    const tick = setInterval(() => {
      const now = Date.now();
      const minute = Math.floor(now / 60_000);
      const price = { BTC: null, ETH: null } as Record<Asset, number | null>;
      const venues = { BTC: 0, ETH: 0 } as Record<Asset, number>;
      for (const a of ASSETS) {
        const c = combine(book.current[a], now);
        price[a] = c.price;
        venues[a] = demo && c.price ? 4 : c.n;
        if (!c.price) continue;
        const s = samples.current[a];
        s.push({ t: now, p: c.price });
        if (s.length > 1000 && now - s[0].t > KEEP_MS) s.splice(0, s.findIndex((x) => now - x.t <= KEEP_MS));
        if (minute !== lastMinute.current) {
          closes.current[a].push(c.price);
          if (closes.current[a].length > 61) closes.current[a].shift();
        }
      }
      lastMinute.current = minute;
      setState({
        price,
        venues,
        realized: { BTC: realizedVol(closes.current.BTC), ETH: realizedVol(closes.current.ETH) },
        implied: { ...implied.current },
        open24: { ...open24.current },
        connected: venues.BTC > 0 || venues.ETH > 0,
        samples,
        history,
      });
    }, SAMPLE_MS);
    cleanups.push(() => clearInterval(tick));

    return () => cleanups.forEach((c) => c());
  }, []);

  return state;
}

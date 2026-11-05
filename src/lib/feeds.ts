"use client";
// Live prices from four venues, combined into one median price per asset.
import { useEffect, useRef, useState } from "react";
import { realizedVol } from "./pricing";

export type Asset = "BTC" | "ETH";
export const ASSETS: Asset[] = ["BTC", "ETH"];
export const TICK: Record<Asset, number> = { BTC: 10, ETH: 1 };

type Venue = "coinbase" | "binance" | "okx" | "hyperliquid";
type Quote = { price: number; at: number };
type VenueBook = Record<Asset, Partial<Record<Venue, Quote>>>;

export type Sample = { t: number; p: number };

export type MarketState = {
  price: Record<Asset, number | null>;
  venues: Record<Asset, number>; // venues contributing right now
  realized: Record<Asset, number>; // annualized, last 60 one-minute closes
  implied: Record<Asset, number | null>; // Deribit DVOL as a decimal
  samples: Record<Asset, Sample[]>; // 1-second medians, last ~2 hours
  connected: boolean;
};

const STALE_MS = 10_000;
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
  const kept = fresh.filter((p, i) => {
    const others = fresh.filter((_, j) => j !== i);
    return Math.abs(p / median(others) - 1) <= OUTLIER;
  });
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

async function fetchCoinbaseCloses(asset: Asset): Promise<number[]> {
  const r = await fetch(`https://api.exchange.coinbase.com/products/${asset}-USD/candles?granularity=60`);
  const rows: number[][] = await r.json();
  return rows.slice(0, 61).reverse().map((row) => row[4]);
}

async function fetchDvol(asset: Asset): Promise<number | null> {
  const end = Date.now();
  const start = end - 2 * 60 * 60_000;
  const r = await fetch(
    `https://www.deribit.com/api/v2/public/get_volatility_index_data?currency=${asset}&start_timestamp=${start}&end_timestamp=${end}&resolution=60`,
  );
  const j = await r.json();
  const data: number[][] = j?.result?.data ?? [];
  if (!data.length) return null;
  return data[data.length - 1][4] / 100;
}

// Average of 1-minute closes in [from, to) from Coinbase, used when the page was closed at expiry.
export async function fetchSettlementFallback(asset: Asset, from: number, to: number): Promise<number | null> {
  try {
    const r = await fetch(
      `https://api.exchange.coinbase.com/products/${asset}-USD/candles?granularity=60&start=${new Date(from).toISOString()}&end=${new Date(to).toISOString()}`,
    );
    const rows: number[][] = await r.json();
    const closes = rows.filter((row) => row[0] * 1000 >= from && row[0] * 1000 < to).map((row) => row[4]);
    if (!closes.length) return null;
    return closes.reduce((a, b) => a + b, 0) / closes.length;
  } catch {
    return null;
  }
}

export function useMarket(): MarketState {
  const book = useRef<VenueBook>({ BTC: {}, ETH: {} });
  const samples = useRef<Record<Asset, Sample[]>>({ BTC: [], ETH: [] });
  const closes = useRef<Record<Asset, number[]>>({ BTC: [], ETH: [] });
  const lastMinute = useRef<number>(0);
  const [state, setState] = useState<MarketState>({
    price: { BTC: null, ETH: null },
    venues: { BTC: 0, ETH: 0 },
    realized: { BTC: 0, ETH: 0 },
    implied: { BTC: null, ETH: null },
    samples: { BTC: [], ETH: [] },
    connected: false,
  });
  const implied = useRef<Record<Asset, number | null>>({ BTC: null, ETH: null });

  useEffect(() => {
    const set = (a: Asset, v: Venue, price: number) => {
      if (Number.isFinite(price) && price > 0) book.current[a][v] = { price, at: Date.now() };
    };
    const assetOf = (s: string): Asset | null => (s.startsWith("BTC") ? "BTC" : s.startsWith("ETH") ? "ETH" : null);

    const closers = [
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
    ];

    // Seed realized vol history and implied vol.
    for (const a of ["BTC", "ETH"] as Asset[]) {
      fetchCoinbaseCloses(a)
        .then((c) => (closes.current[a] = c))
        .catch(() => {});
    }
    const loadIv = () => {
      for (const a of ["BTC", "ETH"] as Asset[]) {
        fetchDvol(a)
          .then((v) => (implied.current[a] = v))
          .catch(() => {});
      }
    };
    loadIv();
    const ivTimer = setInterval(loadIv, 60_000);

    // Once a second: combine venues, record a sample, roll 1-minute closes, publish state.
    const tick = setInterval(() => {
      const now = Date.now();
      const minute = Math.floor(now / 60_000);
      const price = { BTC: null, ETH: null } as Record<Asset, number | null>;
      const venues = { BTC: 0, ETH: 0 } as Record<Asset, number>;
      for (const a of ["BTC", "ETH"] as Asset[]) {
        const c = combine(book.current[a], now);
        price[a] = c.price;
        venues[a] = c.n;
        if (c.price) {
          const s = samples.current[a];
          s.push({ t: now, p: c.price });
          while (s.length && now - s[0].t > 2 * 60 * 60_000) s.shift();
          if (minute !== lastMinute.current) {
            closes.current[a].push(c.price);
            if (closes.current[a].length > 61) closes.current[a].shift();
          }
        }
      }
      lastMinute.current = minute;
      setState({
        price,
        venues,
        realized: { BTC: realizedVol(closes.current.BTC), ETH: realizedVol(closes.current.ETH) },
        implied: { ...implied.current },
        samples: { BTC: samples.current.BTC, ETH: samples.current.ETH },
        connected: venues.BTC > 0 || venues.ETH > 0,
      });
    }, 1000);

    return () => {
      closers.forEach((c) => c());
      clearInterval(tick);
      clearInterval(ivTimer);
    };
  }, []);

  return state;
}

// Settlement price: time-weighted average of 1-second medians over the final 5 minutes.
export function twap(samples: Sample[], from: number, to: number): { price: number | null; coverage: number } {
  const window = samples.filter((s) => s.t >= from && s.t < to);
  if (!window.length) return { price: null, coverage: 0 };
  const avg = window.reduce((a, s) => a + s.p, 0) / window.length;
  return { price: avg, coverage: window.length / ((to - from) / 1000) };
}

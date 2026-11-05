"use client";
// Live prices from four venues, combined into one median price per asset, sampled 4 times a second.
import { useEffect, useRef, useState, type MutableRefObject } from "react";
import { realizedVol } from "./pricing";
import { ASSETS, combine, fetchCoinbaseHistory, fetchDvol, fetchSeconds, settlementPrice, type Asset, type Quote, type Venue } from "./prices";

export { ASSETS, TICK, combine, fetchSeconds, type Asset } from "./prices";
export const SAMPLE_MS = 250;

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

const KEEP_MS = 2 * 60 * 60_000;

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

// Replace everything in [from, to) with fresh points, keeping the series sorted.
function mergeInto(arr: Sample[], from: number, to: number, pts: Sample[]) {
  if (!pts.length) return;
  const a = arr.findIndex((x) => x.t >= from);
  const i = a === -1 ? arr.length : a;
  let j = i;
  while (j < arr.length && arr[j].t < to) j++;
  arr.splice(i, j - i, ...pts.filter((x) => x.t >= from && x.t < to));
}

// The last 2 hours of prices are saved in this browser (one point per second) so a reload doesn't start blank.
const STORE_KEY = "expiry.ticks.v1";
function saveTicks(series: Series) {
  try {
    const slim: Record<string, [number, number][]> = {};
    for (const a of ASSETS) {
      const pts: [number, number][] = [];
      let lastSec = -1;
      for (const x of series[a]) {
        const sec = Math.floor(x.t / 1000);
        if (sec === lastSec) pts[pts.length - 1] = [x.t, x.p];
        else pts.push([x.t, x.p]);
        lastSec = sec;
      }
      slim[a] = pts;
    }
    localStorage.setItem(STORE_KEY, JSON.stringify({ at: Date.now(), slim }));
  } catch {}
}
function loadTicks(): Series | null {
  try {
    const raw = localStorage.getItem(STORE_KEY);
    if (!raw) return null;
    const { slim } = JSON.parse(raw) as { slim: Record<Asset, [number, number][]> };
    const cutoff = Date.now() - KEEP_MS;
    const out = { BTC: [], ETH: [] } as Series;
    for (const a of ASSETS) out[a] = (slim[a] ?? []).filter(([t]) => t > cutoff).map(([t, p]) => ({ t, p }));
    return out;
  } catch {
    return null;
  }
}

// Fallback settlement when the tab was closed during the window (demo and local paper mode):
// Binance 1-second closes, else Coinbase 1-minute candles. Same rule the server settles with.
export async function fetchSettlementFallback(asset: Asset, from: number, to: number): Promise<number | null> {
  return (await settlementPrice(asset, to, to - from))?.price ?? null;
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

      // Fill the time this tab wasn't recording: second-level prices from Binance.
      // On load: from the last saved tick (or 30 minutes back) to now. On return to the tab: from when it was hidden.
      const saved = loadTicks();
      if (saved) for (const a of ASSETS) samples.current[a] = saved[a];
      const backfill = async (from: number) => {
        const to = Date.now();
        const start = Math.max(from, to - KEEP_MS);
        if (to - start < 3000) return;
        for (const a of ASSETS) {
          const pts = await fetchSeconds(a, start, to);
          if (pts.length) mergeInto(samples.current[a], start, pts[pts.length - 1].t + 1, pts);
        }
      };
      const lastSaved = Math.max(saved?.BTC.at(-1)?.t ?? 0, saved?.ETH.at(-1)?.t ?? 0);
      backfill(lastSaved || Date.now() - 30 * 60_000);
      let hiddenAt = 0;
      const onVis = () => {
        if (document.hidden) hiddenAt = Date.now();
        else if (hiddenAt) {
          backfill(hiddenAt - 2000);
          hiddenAt = 0;
        }
      };
      document.addEventListener("visibilitychange", onVis);
      const persist = setInterval(() => saveTicks(samples.current), 15_000);
      const onUnload = () => saveTicks(samples.current);
      window.addEventListener("pagehide", onUnload);
      cleanups.push(() => {
        document.removeEventListener("visibilitychange", onVis);
        window.removeEventListener("pagehide", onUnload);
        clearInterval(persist);
        saveTicks(samples.current);
      });
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

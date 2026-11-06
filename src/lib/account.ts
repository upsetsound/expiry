"use client";
// One account interface for the trade screen, with two implementations:
//   useLocalAccount — ?demo: localStorage, simulated prices, settles in the browser (the original paper mode)
//   useLiveAccount  — Supabase: X sign-in, shared pool, server-side buys and settlement (src/lib/liveAccount.ts)
import { useEffect, useRef, useState } from "react";
import { fetchSettlementFallback, twap, type Asset, type MarketState } from "./feeds";
import { DEFAULT_LIMITS, bid as bidFor, payout as payoutFor, pricingVol, yearsUntil, type Limits, type Side } from "./pricing";
import { canClose } from "./schedule";
import { TENORS, type Tenor } from "./schedule";
import { START_BALANCE, START_POOL, TOP_UP_BELOW, WEEK_MS, freshAccount, loadAccount, saveAccount, type Account, type Position } from "./store";

export type { Position } from "./store";
export type Trader = { id: string; handle: string | null; avatar: string | null };
export type TapeItem = Position & { trader?: Trader };
export type PoolState = { balance: number; premiumsIn: number; paidOut: number };
export type AssetStats = { vol24: number; callOi: number; putOi: number };
export type ServerVol = { sigma: number; implied: number | null; realized: number };
export type LeaderRow = {
  rank: number;
  userId: string;
  handle: string | null;
  avatar: string | null;
  pnl: number;
  trades: number;
  winRate: number;
  bestMultiple: number;
  points: number;
  isMe: boolean;
  eligible: boolean;
  prize: number | null; // USDC, only while prizes are on
};
export type Prizes = { enabled: boolean; amounts: number[]; minTrades: number };
export type Notify = (text: string, tone?: "pos" | "neg" | "info") => void;

export type BuyRequest = {
  asset: Asset;
  side: Side;
  strike: number;
  tenor: Tenor;
  expiry: number;
  premium: number;
  perUnit: number; // shown to the buyer
  spot: number;
  units: number;
  maxPayout: number;
};
export type CloseResult = { ok: true; proceeds: number; position: Position } | { ok: false; message: string; bid?: number };
export type BuyResult = { ok: true; pointsAwarded: number; multiple?: number } | { ok: false; message: string };

export type AccountApi = {
  mode: "demo" | "live";
  ready: boolean;
  signedIn: boolean;
  me: Trader | null;
  balance: number | null;
  points: number | null;
  canTopUp: boolean;
  positions: Position[]; // mine, newest first
  openAll: Position[]; // every open position counted against the pool
  tape: TapeItem[];
  pool: PoolState;
  stats: Record<Asset, AssetStats> | null; // global (live only); demo computes from its own positions
  leaderboard: LeaderRow[] | null; // live only
  vol: Record<Asset, ServerVol> | null; // live: the server's pricing vol, so shown quotes match /api/buy
  prizes: Prizes | null; // live: weekly prize settings from the settings row
  limits: Limits; // per-trade and per-round premium limits and the payout cap (settings row; code defaults in demo)
  buy: (r: BuyRequest) => Promise<BuyResult>;
  topUp: () => Promise<void>;
  close: (p: Position, shownBid: number) => Promise<CloseResult>;
  reset?: () => void;
  signIn?: () => void;
  signOut?: () => void;
};

const fmt = (n: number, d = 0) => n.toLocaleString(undefined, { minimumFractionDigits: d, maximumFractionDigits: d });
const money = (n: number) => `${n >= 0 ? "+" : "−"}${Math.abs(n).toLocaleString(undefined, { style: "currency", currency: "USD" })}`;

export function settledToast(p: Position, price: number, paid: number, notify: Notify) {
  const pnl = paid - p.premium;
  notify(`${p.asset} ${fmt(p.strike)} ${p.side} settled at ${fmt(price, p.asset === "BTC" ? 0 : 2)} · ${money(pnl)}`, pnl >= 0 ? "pos" : "neg");
}

// ?demo: the original single-player paper account, unchanged in behavior.
// Settlement feedback (toast, win card, sounds) is handled by the page via useRoundResults.
export function useLocalAccount(market: MarketState): AccountApi {
  const [acct, setAcct] = useState<Account | null>(null);
  const settling = useRef<Set<string>>(new Set());
  const now = Date.now();

  useEffect(() => setAcct(loadAccount()), []);
  useEffect(() => {
    if (acct) saveAccount(acct);
  }, [acct]);

  // Settle expired positions with the sampled average, else Binance 1s / Coinbase candles.
  useEffect(() => {
    if (!acct) return;
    const due = acct.positions.filter((p) => p.status === "open" && p.expiry <= now && !settling.current.has(p.id));
    for (const p of due) {
      settling.current.add(p.id);
      const from = p.expiry - TENORS[p.tenor].window;
      const lv = twap(market.samples.current[p.asset], from, p.expiry);
      const finish = (price: number) => {
        const paid = payoutFor(p.side, price, p.strike, p.units, p.premium, p.payoutCap ?? 20);
        setAcct((a) => {
          if (!a) return a;
          const pos = a.positions.find((x) => x.id === p.id);
          if (!pos || pos.status !== "open") return a;
          return {
            ...a,
            balance: a.balance + paid,
            pool: a.pool - paid,
            positions: a.positions.map((x) => (x.id === p.id ? { ...x, status: "settled", settle: price, payout: paid } : x)),
          };
        });
      };
      if (lv.price && lv.coverage >= 0.6) finish(lv.price);
      else
        fetchSettlementFallback(p.asset, from, p.expiry).then((price) => {
          if (price) finish(price);
          else settling.current.delete(p.id);
        });
    }
  }, [acct, now, market.samples]);

  const positions = acct?.positions ?? [];
  return {
    mode: "demo",
    ready: !!acct,
    signedIn: true,
    me: null,
    balance: acct?.balance ?? null,
    points: acct?.points ?? null,
    canTopUp: !!acct && acct.balance < TOP_UP_BELOW && now - acct.lastTopUp > WEEK_MS,
    positions,
    openAll: positions.filter((p) => p.status === "open"),
    tape: positions.slice(0, 16),
    pool: {
      balance: acct?.pool ?? START_POOL,
      premiumsIn: positions.reduce((s, p) => s + p.premium, 0),
      paidOut: positions.filter((p) => p.status === "settled").reduce((s, p) => s + (p.payout ?? 0), 0),
    },
    stats: null,
    leaderboard: null,
    vol: null,
    prizes: null,
    limits: DEFAULT_LIMITS,
    async buy(r) {
      if (!acct) return { ok: false, message: "Loading…" };
      const key = `${r.asset}-${r.expiry}`;
      const day = new Date().toISOString().slice(0, 10);
      const pd = acct.pointsDay.day === day ? acct.pointsDay : { day, count: 0 };
      const earns = !acct.tradedExpiries.includes(key) && pd.count < 24;
      const pos: Position = {
        id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
        asset: r.asset,
        side: r.side,
        strike: r.strike,
        tenor: r.tenor,
        expiry: r.expiry,
        premium: r.premium,
        units: r.units,
        maxPayout: r.maxPayout,
        payoutCap: DEFAULT_LIMITS.payoutCap,
        boughtAt: Date.now(),
        spotAtBuy: r.spot,
        status: "open",
      };
      setAcct({
        ...acct,
        balance: acct.balance - r.premium,
        pool: acct.pool + r.premium,
        points: acct.points + (earns ? 10 : 0),
        pointsDay: earns ? { day, count: pd.count + 1 } : pd,
        tradedExpiries: earns ? [...acct.tradedExpiries.slice(-500), key] : acct.tradedExpiries,
        positions: [pos, ...acct.positions].slice(0, 500),
      });
      return { ok: true, pointsAwarded: earns ? 10 : 0 };
    },
    async close(p, shownBid) {
      // Demo: the same bid rule as the server, on the browser's prices.
      const spot = market.price[p.asset];
      if (!acct || !spot) return { ok: false, message: "Waiting for price…" };
      const now = Date.now();
      if (!canClose(p.expiry, p.tenor, now)) return { ok: false, message: "Settling… too late to close" };
      const sigma = pricingVol(market.implied[p.asset], market.realized[p.asset]);
      const b = Math.round(bidFor(p.side, spot, p.strike, sigma, yearsUntil(p.expiry, now), p.units, p.premium, p.payoutCap ?? 20) * 100) / 100;
      if (shownBid > 0 && b < shownBid * 0.98) return { ok: false, message: "Price moved: close at $" + b.toFixed(2) + "?", bid: b };
      const closed: Position = { ...p, status: "closed", closePrice: spot, closeProceeds: b, closedAt: now };
      setAcct((a) =>
        a && a.positions.some((x) => x.id === p.id && x.status === "open")
          ? { ...a, balance: a.balance + b, pool: a.pool - b, positions: a.positions.map((x) => (x.id === p.id ? closed : x)) }
          : a,
      );
      return { ok: true, proceeds: b, position: closed };
    },
    async topUp() {
      if (acct) setAcct({ ...acct, balance: acct.balance + START_BALANCE, lastTopUp: Date.now() });
    },
    reset() {
      setAcct(freshAccount());
    },
  };
}

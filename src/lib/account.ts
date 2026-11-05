"use client";
// One account interface for the trade screen, with two implementations:
//   useLocalAccount — ?demo: localStorage, simulated prices, settles in the browser (the original paper mode)
//   useLiveAccount  — Supabase: X sign-in, shared pool, server-side buys and settlement (src/lib/liveAccount.ts)
import { useEffect, useRef, useState } from "react";
import { fetchSettlementFallback, twap, type Asset, type MarketState } from "./feeds";
import { payout as payoutFor, type Side } from "./pricing";
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
};
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
export type BuyResult = { ok: true; pointsAwarded: number } | { ok: false; message: string; priceMoved?: boolean };

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
  buy: (r: BuyRequest) => Promise<BuyResult>;
  topUp: () => Promise<void>;
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
export function useLocalAccount(market: MarketState, notify: Notify): AccountApi {
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
        const paid = payoutFor(p.side, price, p.strike, p.units, p.premium);
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
        settledToast(p, price, paid, notify);
      };
      if (lv.price && lv.coverage >= 0.6) finish(lv.price);
      else
        fetchSettlementFallback(p.asset, from, p.expiry).then((price) => {
          if (price) finish(price);
          else settling.current.delete(p.id);
        });
    }
  }, [acct, now, market.samples, notify]);

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
    async topUp() {
      if (acct) setAcct({ ...acct, balance: acct.balance + START_BALANCE, lastTopUp: Date.now() });
    },
    reset() {
      setAcct(freshAccount());
    },
  };
}

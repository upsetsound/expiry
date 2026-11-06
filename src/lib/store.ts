"use client";
// Paper-mode account state, kept in this browser's localStorage.
import type { Asset } from "./feeds";
import type { Side } from "./pricing";
import type { Tenor } from "./schedule";

export type Position = {
  id: string;
  asset: Asset;
  side: Side;
  strike: number;
  tenor: Tenor;
  expiry: number;
  premium: number; // dollars paid
  units: number; // units of the underlying
  maxPayout: number;
  payoutCap?: number; // the payout cap when bought (older demo positions: 20)
  boughtAt: number;
  spotAtBuy: number;
  status: "open" | "settled";
  settle?: number;
  payout?: number;
};

export type Account = {
  balance: number;
  pool: number;
  points: number;
  pointsDay: { day: string; count: number };
  tradedExpiries: string[]; // "BTC-<expiry>" keys that already earned points
  lastTopUp: number;
  positions: Position[];
  ladders: Record<string, number[]>; // "BTC-<expiry>" -> strikes, fixed when first shown
};

export const START_BALANCE = 10_000;
export const START_POOL = 250_000;
// Demo mode (?demo) keeps its own account so simulated prices never mix with real ones.
const key = () => {
  try {
    return new URLSearchParams(window.location.search).has("demo") ? "expiry.paper.v2.demo" : "expiry.paper.v2";
  } catch {
    return "expiry.paper.v2";
  }
};

export function freshAccount(): Account {
  return {
    balance: START_BALANCE,
    pool: START_POOL,
    points: 0,
    pointsDay: { day: "", count: 0 },
    tradedExpiries: [],
    lastTopUp: Date.now(),
    positions: [],
    ladders: {},
  };
}

export function loadAccount(): Account {
  try {
    const raw = localStorage.getItem(key());
    if (raw) return { ...freshAccount(), ...JSON.parse(raw) };
  } catch {}
  return freshAccount();
}

export function saveAccount(a: Account) {
  try {
    localStorage.setItem(key(), JSON.stringify(a));
  } catch {}
}

export const WEEK_MS = 7 * 24 * 60 * 60_000;
export const TOP_UP_BELOW = 1_000;

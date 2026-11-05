"use client";
// Watches my positions for open -> settled and reports each round once, after its positions stop settling
// (positions in one round can arrive a moment apart). Positions already settled when first seen are ignored,
// so reloading the page doesn't replay old results.
import { useEffect, useRef } from "react";
import type { Asset } from "./feeds";
import type { Position } from "./store";
import type { Tenor } from "./schedule";

export type RoundResult = {
  key: string;
  asset: Asset;
  tenor: Tenor;
  expiry: number;
  settle: number;
  premium: number;
  payout: number;
  pnl: number;
  multiple: number; // payout / premium for the whole round
  positions: Position[];
};

const GATHER_MS = 1_500;

export function useRoundResults(positions: Position[], onRound: (r: RoundResult) => void) {
  const seen = useRef<Map<string, Position["status"]>>(new Map());
  const pending = useRef<Map<string, { positions: Position[]; timer: ReturnType<typeof setTimeout> }>>(new Map());
  const cb = useRef(onRound);
  cb.current = onRound;

  useEffect(() => {
    for (const p of positions) {
      const before = seen.current.get(p.id);
      seen.current.set(p.id, p.status);
      if (before !== "open" || p.status !== "settled") continue;
      const key = `${p.asset}-${p.tenor}-${p.expiry}`;
      const group = pending.current.get(key);
      if (group) {
        clearTimeout(group.timer);
        group.positions.push(p);
      }
      const g = group ?? { positions: [p], timer: 0 as unknown as ReturnType<typeof setTimeout> };
      g.timer = setTimeout(() => {
        pending.current.delete(key);
        const ps = g.positions;
        const premium = ps.reduce((s, x) => s + x.premium, 0);
        const payout = ps.reduce((s, x) => s + (x.payout ?? 0), 0);
        cb.current({
          key,
          asset: p.asset,
          tenor: p.tenor,
          expiry: p.expiry,
          settle: p.settle ?? 0,
          premium,
          payout,
          pnl: payout - premium,
          multiple: premium > 0 ? payout / premium : 0,
          positions: ps,
        });
      }, GATHER_MS);
      pending.current.set(key, g);
    }
  }, [positions]);

  useEffect(() => {
    const p = pending.current;
    return () => p.forEach((g) => clearTimeout(g.timer));
  }, []);
}

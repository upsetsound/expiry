// Closing a position early: the pool's bid and when closing is allowed.
import { describe, expect, it } from "vitest";
import { RULES, bid, quote } from "@/lib/pricing";
import { canClose, closeDeadline } from "@/lib/schedule";

const YEAR = 365 * 24 * 60 * 60_000;
const SPOT = 76_000;

describe("bid", () => {
  const cases: ["call" | "put", number, number][] = [
    ["call", SPOT, 30 * 60_000],
    ["call", SPOT + 300, 5 * 60_000],
    ["put", SPOT - 150, 45_000],
    ["put", SPOT + 500, 10 * 60_000],
  ];
  it("is below the ask for the same inputs", () => {
    for (const [side, strike, ms] of cases) {
      const T = ms / YEAR;
      const units = 0.5;
      const ask = quote(side, SPOT, strike, 0.5, T) * units;
      const b = bid(side, SPOT, strike, 0.5, T, units, ask);
      expect(b).toBeGreaterThan(0);
      expect(b).toBeLessThan(ask);
      expect(b / ask).toBeCloseTo((1 - RULES.baseEdge) / (1 + RULES.baseEdge), 10);
    }
  });
  it("is never negative", () => {
    expect(bid("call", SPOT, SPOT + 5_000, 0.5, 1e-9, 1, 10)).toBe(0);
    expect(bid("put", SPOT, SPOT - 5_000, 0.5, 0, 1, 10)).toBe(0);
  });
  it("never exceeds the position's cap x premium", () => {
    // Deep in the money with lots of units: fair value is far above the cap.
    expect(bid("call", SPOT, SPOT - 20_000, 0.5, 60_000 / YEAR, 2, 10, 100)).toBe(1000);
    expect(bid("call", SPOT, SPOT - 20_000, 0.5, 60_000 / YEAR, 2, 10, 20)).toBe(200);
  });
});

describe("close deadline", () => {
  const expiry = Date.UTC(2026, 10, 7, 12, 1, 0);
  it("closes until the settlement window starts: last 5s of a 1m round, last 5m of a 1h round", () => {
    expect(closeDeadline(expiry, "1m")).toBe(expiry - 5_000);
    expect(closeDeadline(expiry, "1h")).toBe(expiry - 300_000);
    expect(canClose(expiry, "1m", expiry - 5_001)).toBe(true);
    expect(canClose(expiry, "1m", expiry - 5_000)).toBe(false);
    expect(canClose(expiry, "1h", expiry - 299_000)).toBe(false);
  });
});

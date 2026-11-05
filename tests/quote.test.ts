// Client and server price a ticket the same way, and stale quotes are rejected.
import { describe, expect, it } from "vitest";
import { QUOTE_TOLERANCE, RULES, payout, priceTicket, strikeStep } from "@/lib/pricing";
import { TICK } from "@/lib/prices";
import { nextExpiry } from "@/lib/schedule";
import { parseBuy, prepareBuy, type BuyInput } from "@/lib/server/buy";

const NOW = Date.UTC(2026, 10, 5, 21, 0, 20); // 20s into a minute: 1m round at :01 is on sale
const SPOT = 76_000;
const SIGMA = 0.42;

// What the browser's ticket shows for these inputs (page.tsx uses priceTicket + strikeStep the same way).
function clientTicket(side: "call" | "put", tenor: "1m" | "5m" | "15m" | "1h", off: number, premium: number) {
  const expiry = nextExpiry(tenor, NOW);
  const em = priceTicket(side, SPOT, SPOT, SIGMA, expiry, NOW, premium).em;
  const step = strikeStep(em, TICK.BTC);
  const strike = Math.round(SPOT / step) * step + off * step;
  return { expiry, strike, ...priceTicket(side, SPOT, strike, SIGMA, expiry, NOW, premium) };
}

const input = (t: ReturnType<typeof clientTicket>, side: "call" | "put", tenor: BuyInput["tenor"], premium: number, perUnit = t.perUnit): BuyInput => ({
  asset: "BTC",
  side,
  strike: t.strike,
  tenor,
  expiry: t.expiry,
  premium,
  perUnit,
});

describe("client and server quotes match", () => {
  for (const tenor of ["1m", "5m", "15m", "1h"] as const) {
    for (const side of ["call", "put"] as const) {
      for (const off of [-4, -1, 0, 2, 4]) {
        it(`${tenor} ${side} ${off >= 0 ? "+" : ""}${off} steps`, () => {
          const t = clientTicket(side, tenor, off, 25);
          const r = prepareBuy(input(t, side, tenor, 25), { spot: SPOT, sigma: SIGMA }, NOW);
          expect(r.ok).toBe(true);
          if (!r.ok) return;
          expect(r.quote.perUnit).toBe(t.perUnit);
          expect(r.rpc.p_units).toBe(t.units);
          expect(r.rpc.p_max_payout).toBeCloseTo(t.maxPayout, 2);
          expect(r.rpc.p_max_payout).toBeLessThanOrEqual(RULES.payoutCap * 25 + 0.005);
        });
      }
    }
  }
});

describe("stale quotes", () => {
  const t = clientTicket("call", "5m", 0, 50);
  it(`accepts a quote within ${QUOTE_TOLERANCE * 100}%`, () => {
    expect(prepareBuy(input(t, "call", "5m", 50, t.perUnit * 1.019), { spot: SPOT, sigma: SIGMA }, NOW).ok).toBe(true);
    expect(prepareBuy(input(t, "call", "5m", 50, t.perUnit * 0.981), { spot: SPOT, sigma: SIGMA }, NOW).ok).toBe(true);
  });
  it("rejects a quote more than 2% off and returns the new quote", () => {
    for (const k of [1.021, 0.979, 1.5]) {
      const r = prepareBuy(input(t, "call", "5m", 50, t.perUnit * k), { spot: SPOT, sigma: SIGMA }, NOW);
      expect(r.ok).toBe(false);
      if (r.ok) return;
      expect(r.error).toBe("price_moved");
      expect(r.message).toBe("Price moved, try again");
      expect(r.quote?.perUnit).toBe(t.perUnit);
    }
  });
  it("rejects when the market moved under the shown quote", () => {
    const r = prepareBuy(input(t, "call", "5m", 50), { spot: SPOT * 1.002, sigma: SIGMA }, NOW);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toBe("price_moved");
  });
});

describe("server-side checks", () => {
  const t = clientTicket("put", "1m", 0, 10);
  it("enforces the sales cutoff on the server clock", () => {
    // 1m sales stop 15s before expiry: at :46 the :01 round is closed.
    const late = t.expiry - 14_000;
    const r = prepareBuy(input(t, "put", "1m", 10), { spot: SPOT, sigma: SIGMA }, late);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toBe("sales_closed");
  });
  it("rejects rounds that aren't on sale yet", () => {
    const r = prepareBuy({ ...input(t, "put", "1m", 10), expiry: t.expiry + 60_000 }, { spot: SPOT, sigma: SIGMA }, NOW);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toBe("bad_expiry");
  });
  it("rejects strikes outside the ladder", () => {
    const step = strikeStep(t.em, TICK.BTC);
    const r = prepareBuy({ ...input(t, "put", "1m", 10), strike: Math.round(SPOT / step) * step + 7 * step }, { spot: SPOT, sigma: SIGMA }, NOW);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toBe("bad_strike");
  });
  it("enforces the per-trade premium limits", () => {
    const hi = prepareBuy(input(t, "put", "1m", 250.01), { spot: SPOT, sigma: SIGMA }, NOW);
    const lo = prepareBuy(input(t, "put", "1m", 0.5), { spot: SPOT, sigma: SIGMA }, NOW);
    expect(!hi.ok && hi.error).toBe("max_per_trade");
    expect(!lo.ok && lo.error).toBe("min_premium");
  });
  it("parses and rounds input, rejecting junk", () => {
    expect(parseBuy({ ...input(t, "put", "1m", 10.239) })?.premium).toBe(10.24);
    expect(parseBuy({ ...input(t, "put", "1m", 10), asset: "SOL" })).toBeNull();
    expect(parseBuy({ ...input(t, "put", "1m", 10), strike: "75000" })).toBeNull();
    expect(parseBuy(null)).toBeNull();
  });
});

describe("payout rule", () => {
  it("caps at 20x premium", () => {
    expect(payout("call", 80_000, 76_000, 1, 10)).toBe(200);
    expect(payout("put", 80_000, 76_000, 1, 10)).toBe(0);
  });
});

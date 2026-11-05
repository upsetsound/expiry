// Payout multiples shown on the ticket and the chart.
import { describe, expect, it } from "vitest";
import { RULES, bsPrice, liveMultiple, priceTicket, strikeStep, winMultiple } from "@/lib/pricing";
import { shareText } from "@/lib/share";

const SPOT = 76_000;
const SIGMA = 0.5;
const T5m = 5 * 60_000 / (365 * 24 * 60 * 60_000);

describe("winMultiple", () => {
  it("is about 1.8x at the money", () => {
    for (const side of ["call", "put"] as const) {
      for (const T of [T5m / 5, T5m, T5m * 12]) {
        const m = winMultiple(side, SPOT, SPOT, SIGMA, T);
        expect(m).toBeGreaterThan(1.75);
        expect(m).toBeLessThan(1.9);
      }
    }
  });

  it("rises as strikes move out of the money", () => {
    const em = priceTicket("call", SPOT, SPOT, SIGMA, 5 * 60_000, 0, 10).em;
    const step = strikeStep(em, 10);
    const calls = [0, 1, 2, 3, 4].map((k) => winMultiple("call", SPOT, SPOT + k * step, SIGMA, T5m));
    const puts = [0, 1, 2, 3, 4].map((k) => winMultiple("put", SPOT, SPOT - k * step, SIGMA, T5m));
    for (const xs of [calls, puts]) for (let i = 1; i < xs.length; i++) expect(xs[i]).toBeGreaterThan(xs[i - 1]);
    // In the money goes the other way: below ATM for calls is a smaller multiple.
    expect(winMultiple("call", SPOT, SPOT - step, SIGMA, T5m)).toBeLessThan(calls[0]);
  });

  it("never exceeds the 20x cap", () => {
    const cases: [number, number][] = [
      [SPOT * 1.05, T5m],
      [SPOT * 1.5, T5m],
      [SPOT * 1.001, 1e-9],
      [SPOT * 1.01, 0],
    ];
    for (const [k, T] of cases) {
      expect(winMultiple("call", SPOT, k, SIGMA, T)).toBeLessThanOrEqual(RULES.payoutCap);
      expect(winMultiple("put", SPOT, 2 * SPOT - k, SIGMA, T)).toBeLessThanOrEqual(RULES.payoutCap);
    }
    expect(winMultiple("call", SPOT, SPOT * 1.5, SIGMA, T5m)).toBe(RULES.payoutCap);
  });

});

describe("liveMultiple", () => {
  const pos = { side: "call" as const, strike: SPOT, units: 0.5, premium: 10, expiry: 5 * 60_000 };
  it("is the position's current value over its premium", () => {
    const m = liveMultiple(pos, SPOT, SIGMA, 0);
    expect(m).toBeCloseTo((bsPrice("call", SPOT, SPOT, SIGMA, T5m) * 0.5) / 10, 10);
  });
  it("is capped at 20x and is intrinsic at expiry", () => {
    expect(liveMultiple(pos, SPOT * 2, SIGMA, 0)).toBe(RULES.payoutCap);
    expect(liveMultiple(pos, SPOT + 20, SIGMA, pos.expiry)).toBeCloseTo(1, 10);
    expect(liveMultiple(pos, SPOT - 20, SIGMA, pos.expiry)).toBe(0);
  });
});

describe("share text", () => {
  const r = {
    key: "k", asset: "BTC" as const, tenor: "1m" as const, expiry: 0, settle: 76_000, premium: 10, payout: 84, pnl: 74, multiple: 8.4,
    positions: [{ id: "1", asset: "BTC" as const, side: "call" as const, strike: 75_900, tenor: "1m" as const, expiry: 0, premium: 10, units: 1, maxPayout: 200, boughtAt: 0, spotAtBuy: 75_900, status: "settled" as const }],
  };
  it("fills in the multiple, tenor, asset, side, handle and site", () => {
    expect(shareText(r, "expiryapp", "https://expiry.example/")).toBe("Just hit 8.4× on a 1-minute BTC call on @expiryapp 📈 expiry.example");
  });
  it("leaves out an empty handle or site", () => {
    expect(shareText(r, "", "https://expiry.example")).toBe("Just hit 8.4× on a 1-minute BTC call 📈 expiry.example");
    expect(shareText(r, "@expiryapp", "")).toBe("Just hit 8.4× on a 1-minute BTC call on @expiryapp 📈");
    expect(shareText(r, "", "")).toBe("Just hit 8.4× on a 1-minute BTC call 📈");
  });
});

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

describe("prepareClose", async () => {
  const { prepareClose, parseClose } = await import("@/lib/server/close");
  const NOW = Date.UTC(2026, 10, 7, 12, 30, 0);
  const pos = {
    id: "7b4c2f1e-9a3d-4e8b-b1c2-0d9e8f7a6b5c",
    user_id: "u1",
    asset: "BTC" as const,
    side: "call" as const,
    strike: 76_200,
    tenor: "1h" as const,
    expiry: new Date(NOW + 20 * 60_000).toISOString(),
    premium: 10,
    units: 0.2,
    payout_cap: 100,
    status: "open",
  };
  const mkt = { spot: 76_000, sigma: 0.5 };
  const fair = bid(pos.side, mkt.spot, pos.strike, mkt.sigma, (20 * 60_000) / YEAR, pos.units, pos.premium, 100);

  it("closes at the server's bid when within 2% of, or better than, the shown bid", () => {
    for (const shown of [fair, fair * 1.019, fair * 0.5]) {
      const r = prepareClose(pos, shown, mkt, "u1", NOW);
      expect(r.ok).toBe(true);
      if (r.ok) expect(r.rpc.p_proceeds).toBeCloseTo(fair, 2);
    }
  });
  it("rejects a bid more than 2% worse than shown and returns the new bid", () => {
    const r = prepareClose(pos, fair * 1.03, mkt, "u1", NOW);
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.error).toBe("price_moved");
      expect(r.bid).toBeCloseTo(fair, 2);
    }
  });
  it("refuses other people's, closed, settled, and in-window closes", () => {
    expect(prepareClose(pos, fair, mkt, "someone-else", NOW)).toMatchObject({ ok: false, error: "not_found" });
    expect(prepareClose({ ...pos, status: "closed" }, fair, mkt, "u1", NOW)).toMatchObject({ ok: false, error: "not_open" });
    expect(prepareClose({ ...pos, status: "settled" }, fair, mkt, "u1", NOW)).toMatchObject({ ok: false, error: "not_open" });
    expect(prepareClose(pos, fair, mkt, "u1", Date.parse(pos.expiry) - 299_000)).toMatchObject({ ok: false, error: "settling" });
  });
  it("parses input strictly", () => {
    expect(parseClose({ positionId: pos.id, bid: 1.5 })).toEqual({ positionId: pos.id, bid: 1.5 });
    expect(parseClose({ positionId: "nope", bid: 1 })).toBeNull();
    expect(parseClose({ positionId: pos.id, bid: -1 })).toBeNull();
  });
});

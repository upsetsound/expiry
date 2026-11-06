// Pricing and checks for POST /api/close, kept free of I/O so it can be tested directly.
import { RULES, bid as bidFor, yearsUntil, type Side } from "@/lib/pricing";
import { canClose, type Tenor } from "@/lib/schedule";

export const CLOSE_TOLERANCE = 0.02;

export type ClosablePosition = {
  id: string;
  user_id: string;
  asset: "BTC" | "ETH";
  side: Side;
  strike: number;
  tenor: Tenor;
  expiry: string; // ISO
  premium: number;
  units: number;
  payout_cap: number;
  status: string;
};

export type PreparedClose =
  | { ok: false; status: number; error: string; message: string; bid?: number }
  | { ok: true; bid: number; rpc: { p_position: string; p_price: number; p_proceeds: number } };

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function parseClose(body: unknown): { positionId: string; bid: number } | null {
  const b = body as { positionId?: unknown; bid?: unknown } | null;
  if (!b || typeof b.positionId !== "string" || !UUID.test(b.positionId)) return null;
  if (typeof b.bid !== "number" || !Number.isFinite(b.bid) || b.bid < 0) return null;
  return { positionId: b.positionId, bid: b.bid };
}

// Price the buy-back on the server's spot, sigma and clock. Rejects a bid more than 2% below what the seller was
// shown (returning the new bid); a better bid is fine.
export function prepareClose(
  pos: ClosablePosition,
  shownBid: number,
  market: { spot: number; sigma: number },
  userId: string,
  now: number,
): PreparedClose {
  if (pos.user_id !== userId) return { ok: false, status: 404, error: "not_found", message: "Position not found" };
  if (pos.status !== "open") {
    return { ok: false, status: 409, error: "not_open", message: pos.status === "closed" ? "Already closed" : "Already settled" };
  }
  const expiry = Date.parse(pos.expiry);
  if (!canClose(expiry, pos.tenor, now)) return { ok: false, status: 409, error: "settling", message: "Settling… too late to close" };
  const raw = bidFor(
    pos.side,
    market.spot,
    Number(pos.strike),
    market.sigma,
    yearsUntil(expiry, now),
    Number(pos.units),
    Number(pos.premium),
    Number(pos.payout_cap ?? RULES.payoutCap),
  );
  const b = Math.round(raw * 100) / 100;
  if (shownBid > 0 && b < shownBid * (1 - CLOSE_TOLERANCE)) {
    return { ok: false, status: 409, error: "price_moved", message: "Price moved: close at $" + b.toFixed(2) + "?", bid: b };
  }
  return { ok: true, bid: b, rpc: { p_position: pos.id, p_price: market.spot, p_proceeds: b } };
}

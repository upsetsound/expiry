// Pricing rules from the Expiry mechanism one-pager.

export const RULES = {
  baseEdge: 0.10, // 10% over fair value
  volFloor: 0.35, // 35% annualized floor
  realizedMult: 1.25, // 1.25 x realized vol
  // Defaults (demo mode, and live until the settings row loads). Live values come from the Supabase settings row.
  payoutCap: 100, // max payout = 100 x premium
  maxPremiumPerPosition: 1000,
  maxPremiumPerExpiry: 5000, // per user, per round (asset + expiry)
  sidePoolShare: 0.3, // per expiry, per side: max payout <= 30% of pool
  totalPoolShare: 0.6, // all open options: max payout <= 60% of pool
  ladderK: [-2, -1.5, -1, -0.5, 0, 0.5, 1, 1.5, 2],
  minPremium: 1,
};

const YEAR_MS = 365 * 24 * 60 * 60 * 1000;

// The limits that can change without a deploy (Supabase settings row). Code defaults above.
export type Limits = { maxPerTrade: number; maxPerRound: number; payoutCap: number };
export const DEFAULT_LIMITS: Limits = { maxPerTrade: RULES.maxPremiumPerPosition, maxPerRound: RULES.maxPremiumPerExpiry, payoutCap: RULES.payoutCap };

export type Side = "call" | "put";

// Standard normal CDF (Abramowitz & Stegun 7.1.26 via erf).
export function normCdf(x: number): number {
  const t = 1 / (1 + 0.3275911 * Math.abs(x) / Math.SQRT2);
  const y =
    1 -
    (((((1.061405429 * t - 1.453152027) * t + 1.421413741) * t - 0.284496736) * t + 0.254829592) *
      t *
      Math.exp(-(x * x) / 2));
  return x >= 0 ? 0.5 * (1 + y) : 0.5 * (1 - y);
}

// Black-Scholes with zero rate. T in years.
export function bsPrice(side: Side, spot: number, strike: number, sigma: number, T: number): number {
  if (T <= 0 || sigma <= 0) return Math.max(side === "call" ? spot - strike : strike - spot, 0);
  const sqrtT = Math.sqrt(T);
  const d1 = (Math.log(spot / strike) + 0.5 * sigma * sigma * T) / (sigma * sqrtT);
  const d2 = d1 - sigma * sqrtT;
  return side === "call"
    ? spot * normCdf(d1) - strike * normCdf(d2)
    : strike * normCdf(-d2) - spot * normCdf(-d1);
}

export function yearsUntil(expiryMs: number, nowMs: number): number {
  return Math.max(expiryMs - nowMs, 0) / YEAR_MS;
}

// Annualized realized vol from evenly spaced closes (default 1-minute).
export function realizedVol(closes: number[], intervalMs = 60_000): number {
  if (closes.length < 3) return 0;
  const rets: number[] = [];
  for (let i = 1; i < closes.length; i++) rets.push(Math.log(closes[i] / closes[i - 1]));
  const mean = rets.reduce((a, b) => a + b, 0) / rets.length;
  const variance = rets.reduce((a, b) => a + (b - mean) ** 2, 0) / (rets.length - 1);
  return Math.sqrt(variance * (YEAR_MS / intervalMs));
}

// sigma = max(market implied vol, 1.25 x realized, 35% floor)
export function pricingVol(impliedVol: number | null, realized: number): number {
  return Math.max(impliedVol ?? 0, RULES.realizedMult * realized, RULES.volFloor);
}

export function expectedMove(spot: number, sigma: number, T: number): number {
  return spot * sigma * Math.sqrt(T);
}

export function strikeLadder(spot: number, sigma: number, T: number, tick: number): number[] {
  const em = expectedMove(spot, sigma, T);
  const strikes = RULES.ladderK.map((k) => Math.round((spot + k * em) / tick) * tick);
  return Array.from(new Set(strikes)).sort((a, b) => a - b);
}

// Premium per 1 unit of the underlying, including the house edge.
export function quote(side: Side, spot: number, strike: number, sigma: number, T: number): number {
  return bsPrice(side, spot, strike, sigma, T) * (1 + RULES.baseEdge);
}

export function intrinsic(side: Side, settle: number, strike: number): number {
  return Math.max(side === "call" ? settle - strike : strike - settle, 0);
}

// Payout for a position: units x intrinsic, capped at cap x premium (the cap the position was bought with).
export function payout(side: Side, settle: number, strike: number, units: number, premium: number, cap = RULES.payoutCap): number {
  return Math.min(units * intrinsic(side, settle, strike), cap * premium);
}

// Max payout used for the pool's liability limits: the payout if the price ends one expected move past the strike
// or three expected moves from spot, whichever is further, capped at cap x premium. (A strike beyond the 3-move
// stress price would otherwise count as zero risk even though it can pay the full cap.)
export function maxPayout(side: Side, spot: number, strike: number, units: number, premium: number, em: number, cap = RULES.payoutCap): number {
  const stress = side === "call" ? Math.max(spot + 3 * em, strike + em) : Math.min(spot - 3 * em, strike - em);
  return Math.min(units * intrinsic(side, stress, strike), cap * premium);
}

// Strikes offered: at-the-money plus up to this many steps either side (strike stepper; superseded by the
// leverage slider, which searches out to MAX_EM_OUT expected moves).
export const MAX_STRIKE_STEPS = 4;
export const MAX_EM_OUT = 4;

// Strike step: a round number near half an expected move, at least one tick.
export function strikeStep(em: number, tick: number): number {
  if (!em) return tick;
  const raw = em * 0.5;
  const mag = 10 ** Math.floor(Math.log10(raw));
  const n = raw / mag;
  const nice = (n < 1.5 ? 1 : n < 3.5 ? 2.5 : n < 7 ? 5 : 10) * mag;
  return Math.max(tick, Math.round(nice / tick) * tick);
}

// Everything a ticket needs from the market inputs. The client's ticket and the server's /api/buy both use this.
export function priceTicket(side: Side, spot: number, strike: number, sigma: number, expiryMs: number, nowMs: number, premium: number, cap = RULES.payoutCap) {
  const T = yearsUntil(expiryMs, nowMs);
  const em = expectedMove(spot, sigma, T);
  const perUnit = quote(side, spot, strike, sigma, T);
  const units = perUnit > 0 ? premium / perUnit : 0;
  return { T, em, perUnit, units, maxPayout: maxPayout(side, spot, strike, units, premium, em, cap) };
}

// Chance the option finishes in the money under the pricing vol (no edge).
export function probITM(side: Side, spot: number, strike: number, sigma: number, T: number): number {
  if (T <= 0 || sigma <= 0) return intrinsic(side, spot, strike) > 0 ? 1 : 0;
  const d2 = (Math.log(spot / strike) - 0.5 * sigma * sigma * T) / (sigma * Math.sqrt(T));
  return side === "call" ? normCdf(d2) : normCdf(-d2);
}

// Average multiple of the premium paid back when the option finishes in the money:
// fair value / chance of finishing in the money, after the house edge, capped at the payout cap.
// About 1.8x at the money; far strikes reach the 20x cap.
export function winMultiple(side: Side, spot: number, strike: number, sigma: number, T: number, cap = RULES.payoutCap): number {
  const p = probITM(side, spot, strike, sigma, T);
  if (!(p > 0)) return cap;
  return Math.min(cap, 1 / ((1 + RULES.baseEdge) * p));
}

// What an open position is worth right now as a multiple of its premium (fair value, capped like the payout).
export function liveMultiple(
  pos: { side: Side; strike: number; units: number; premium: number; expiry: number; payoutCap?: number },
  spot: number,
  sigma: number,
  nowMs: number,
): number {
  const cap = pos.payoutCap ?? RULES.payoutCap;
  const value = Math.min(bsPrice(pos.side, spot, pos.strike, sigma, yearsUntil(pos.expiry, nowMs)) * pos.units, cap * pos.premium);
  return pos.premium > 0 ? value / pos.premium : 0;
}

// Leverage slider: the win multiples a buyer can pick.
export const LEVERAGE_STOPS = [2, 3, 5, 10, 20, 50, 100];
export type StrikeOption = { strike: number; multiple: number; chance: number };

// Out-of-the-money strikes for one side, from the at-the-money strike outward on the asset's tick, out to
// MAX_EM_OUT expected moves, with their win multiple and chance of finishing in the money.
export function strikeOptions(side: Side, spot: number, sigma: number, T: number, tick: number, cap = RULES.payoutCap): StrikeOption[] {
  const em = expectedMove(spot, sigma, T);
  const atm = Math.round(spot / tick) * tick;
  const dir = side === "call" ? 1 : -1;
  const out: StrikeOption[] = [];
  for (let k = 0; k < 2000; k++) {
    const strike = atm + dir * k * tick;
    if (strike <= 0 || (k > 0 && Math.abs(strike - spot) > MAX_EM_OUT * em)) break;
    out.push({ strike, multiple: winMultiple(side, spot, strike, sigma, T, cap), chance: probITM(side, spot, strike, sigma, T) });
  }
  return out;
}

// The strike whose win multiple is closest to the target (compared on a log scale, so 10x sits between 5x and
// 20x). reachable = some strike gets within 10% of the target; max = the highest multiple on offer.
export function strikeForMultiple(options: StrikeOption[], target: number): { option: StrikeOption | null; reachable: boolean; max: number } {
  if (!options.length) return { option: null, reachable: false, max: 0 };
  let best = options[0];
  let max = 0;
  for (const o of options) {
    if (o.multiple > max) max = o.multiple;
    if (Math.abs(Math.log(o.multiple / target)) < Math.abs(Math.log(best.multiple / target))) best = o;
  }
  return { option: best, reachable: max >= target * 0.9, max };
}

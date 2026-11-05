// Pricing rules from the Expiry mechanism one-pager.

export const RULES = {
  baseEdge: 0.10, // 10% over fair value
  volFloor: 0.35, // 35% annualized floor
  realizedMult: 1.25, // 1.25 x realized vol
  payoutCap: 20, // max payout = 20 x premium
  maxPremiumPerPosition: 250,
  maxPremiumPerExpiry: 1000,
  sidePoolShare: 0.3, // per expiry, per side: max payout <= 30% of pool
  totalPoolShare: 0.6, // all open options: max payout <= 60% of pool
  ladderK: [-2, -1.5, -1, -0.5, 0, 0.5, 1, 1.5, 2],
  minPremium: 1,
};

const YEAR_MS = 365 * 24 * 60 * 60 * 1000;

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

// Payout for a position: units x intrinsic, capped at payoutCap x premium.
export function payout(side: Side, settle: number, strike: number, units: number, premium: number): number {
  return Math.min(units * intrinsic(side, settle, strike), RULES.payoutCap * premium);
}

// Max payout used for liability caps: the lower of the 20x cap and payout at a 3-expected-move price.
export function maxPayout(side: Side, spot: number, strike: number, units: number, premium: number, em: number): number {
  const stress = side === "call" ? spot + 3 * em : spot - 3 * em;
  return Math.min(units * intrinsic(side, stress, strike), RULES.payoutCap * premium);
}

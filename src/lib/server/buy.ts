// Validation and pricing for POST /api/buy, kept free of I/O so it can be tested directly.
import { ASSETS, TICK, type Asset } from "@/lib/prices";
import { MAX_STRIKE_STEPS, QUOTE_TOLERANCE, RULES, priceTicket, strikeStep, type Side } from "@/lib/pricing";
import { TENORS, TENOR_LIST, nextExpiry, type Tenor } from "@/lib/schedule";

export type BuyInput = {
  asset: Asset;
  side: Side;
  strike: number;
  tenor: Tenor;
  expiry: number; // ms
  premium: number; // dollars
  perUnit: number; // premium per unit the buyer was shown
};

export type BuyQuote = { perUnit: number; spot: number; sigma: number; strike: number; expiry: number };

export type Prepared =
  | { ok: false; status: number; error: string; message: string; quote?: BuyQuote }
  | {
      ok: true;
      quote: BuyQuote;
      rpc: {
        p_asset: Asset;
        p_side: Side;
        p_strike: number;
        p_tenor: Tenor;
        p_expiry: string;
        p_window_ms: number;
        p_premium: number;
        p_units: number;
        p_max_payout: number;
        p_spot: number;
        p_sigma: number;
      };
    };

const fail = (status: number, error: string, message: string, quote?: BuyQuote): Prepared => ({ ok: false, status, error, message, quote });
const finite = (x: unknown): x is number => typeof x === "number" && Number.isFinite(x);

export function parseBuy(body: unknown): BuyInput | null {
  const b = body as Partial<BuyInput> | null;
  if (!b || typeof b !== "object") return null;
  if (!ASSETS.includes(b.asset as Asset)) return null;
  if (b.side !== "call" && b.side !== "put") return null;
  if (!TENOR_LIST.includes(b.tenor as Tenor)) return null;
  if (![b.strike, b.expiry, b.premium, b.perUnit].every(finite)) return null;
  if (b.strike! <= 0 || b.perUnit! <= 0) return null;
  return {
    asset: b.asset as Asset,
    side: b.side,
    strike: b.strike!,
    tenor: b.tenor as Tenor,
    expiry: b.expiry!,
    premium: Math.round(b.premium! * 100) / 100,
    perUnit: b.perUnit!,
  };
}

// Price the trade on the server's own spot, sigma and clock, and check everything that doesn't need the database.
// Balance, per-expiry, pool-liability, rate-limit and points rules run inside buy_position() under row locks.
export function prepareBuy(input: BuyInput, market: { spot: number; sigma: number }, now: number): Prepared {
  const { asset, side, strike, tenor, expiry, premium } = input;
  const { spot, sigma } = market;

  if (premium < RULES.minPremium) return fail(400, "min_premium", `Minimum $${RULES.minPremium}`);
  if (premium > RULES.maxPremiumPerPosition) return fail(400, "max_per_trade", `Max $${RULES.maxPremiumPerPosition} per trade`);

  // Sales cutoff: the only round on sale is the next one whose cutoff hasn't passed, on the server's clock.
  const open = nextExpiry(tenor, now);
  if (expiry !== open) {
    return expiry < open
      ? fail(409, "sales_closed", "Sales closed for this round")
      : fail(400, "bad_expiry", "That round isn't on sale yet");
  }

  const t = priceTicket(side, spot, strike, sigma, expiry, now, premium);
  const quote: BuyQuote = { perUnit: t.perUnit, spot, sigma, strike, expiry };

  // Strikes: at the money plus MAX_STRIKE_STEPS steps either side, on the asset's tick. One extra step of slack
  // covers the at-the-money strike rolling between the buyer's price and ours.
  const step = strikeStep(t.em, TICK[asset]);
  const onTick = Math.abs(strike / TICK[asset] - Math.round(strike / TICK[asset])) < 1e-6;
  if (!onTick || Math.abs(strike - spot) > (MAX_STRIKE_STEPS + 1) * step) return fail(400, "bad_strike", "Strike is out of range", quote);

  if (!(t.perUnit > 0) || !(t.units > 0)) return fail(409, "no_value", "This option has no value left", quote);
  // One-sided slippage: reject only if the buyer would pay more than shown + 2%. Cheaper fills at the server price.
  if (t.perUnit / input.perUnit - 1 > QUOTE_TOLERANCE) return fail(409, "price_moved", "Price moved, try again", quote);
  // Checked after the price so a market jump reads as "Price moved". No in-the-money strikes (their win multiple is under 1.8x). The at-the-money strike is rounded to a step, so
  // it can sit up to half a step in the money; allow 0.75 step to cover the buyer's and our spot differing.
  const itm = side === "call" ? spot - strike : strike - spot;
  if (itm > 0.75 * step) return fail(400, "itm_strike", "In-the-money strikes aren't offered", quote);

  return {
    ok: true,
    quote,
    rpc: {
      p_asset: asset,
      p_side: side,
      p_strike: strike,
      p_tenor: tenor,
      p_expiry: new Date(expiry).toISOString(),
      p_window_ms: TENORS[tenor].window,
      p_premium: premium,
      p_units: t.units,
      p_max_payout: Math.round(t.maxPayout * 100) / 100,
      p_spot: spot,
      p_sigma: sigma,
    },
  };
}

// Messages for buy_position() errors.
export const DB_ERRORS: Record<string, [number, string]> = {
  no_profile: [403, "Account not found — sign in again"],
  rate_limited: [429, "One buy per second — try again"],
  min_premium: [400, `Minimum $${RULES.minPremium}`],
  max_per_trade: [400, `Max $${RULES.maxPremiumPerPosition} per trade`],
  balance: [400, "Not enough balance"],
  max_per_expiry: [400, `Max $${RULES.maxPremiumPerExpiry} per expiry`],
  pool_limit: [409, "Pool limit reached"],
};

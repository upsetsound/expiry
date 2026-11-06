// Validation and pricing for POST /api/buy, kept free of I/O so it can be tested directly.
import { ASSETS, TICK, type Asset } from "@/lib/prices";
import { DEFAULT_LIMITS, MAX_EM_OUT, RULES, priceTicket, strikeStep, winMultiple, type Limits, type Side } from "@/lib/pricing";
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

export type BuyQuote = { perUnit: number; spot: number; sigma: number; strike: number; expiry: number; multiple: number; slippage: number };

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
export function prepareBuy(input: BuyInput, market: { spot: number; sigma: number }, now: number, limits: Limits = DEFAULT_LIMITS): Prepared {
  const { asset, side, strike, tenor, expiry, premium } = input;
  const { spot, sigma } = market;

  if (premium < RULES.minPremium) return fail(400, "min_premium", `Minimum $${RULES.minPremium}`);
  if (premium > limits.maxPerTrade) return fail(400, "max_per_trade", `Max $${limits.maxPerTrade.toLocaleString("en-US")} per trade`);

  // Sales cutoff: the only round on sale is the next one whose cutoff hasn't passed, on the server's clock.
  const open = nextExpiry(tenor, now);
  if (expiry !== open) {
    return expiry < open
      ? fail(409, "sales_closed", "Sales closed for this round")
      : fail(400, "bad_expiry", "That round isn't on sale yet");
  }

  const t = priceTicket(side, spot, strike, sigma, expiry, now, premium, limits.payoutCap);
  // Filled at the server's price, whatever the buyer saw: the premium in dollars is fixed, so a move only changes
  // the units (and the win multiple) it buys. slippage = how much dearer than shown (+) or cheaper (-).
  const quote: BuyQuote = {
    perUnit: t.perUnit,
    spot,
    sigma,
    strike,
    expiry,
    multiple: winMultiple(side, spot, strike, sigma, t.T, limits.payoutCap),
    slippage: t.perUnit / input.perUnit - 1,
  };

  // Strikes: on the asset's tick, at most MAX_EM_OUT expected moves from spot (plus a step of slack for the
  // price moving between the buyer's screen and ours).
  const step = strikeStep(t.em, TICK[asset]);
  const onTick = Math.abs(strike / TICK[asset] - Math.round(strike / TICK[asset])) < 1e-6;
  if (!onTick || Math.abs(strike - spot) > MAX_EM_OUT * t.em + step) return fail(400, "bad_strike", "Strike is out of range", quote);

  if (!(t.perUnit > 0) || !(t.units > 0)) return fail(409, "no_value", "This option has no value left", quote);
  // No in-the-money strikes. The at-the-money strike is rounded to a step (up to half a step in the money), and the
  // market can move between the buyer's screen and ours, so allow 1.5 steps before calling it in the money.
  const itm = side === "call" ? spot - strike : strike - spot;
  if (itm > 1.5 * step) return fail(400, "itm_strike", "In-the-money strikes aren't offered", quote);

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
  max_per_trade: [400, "Over the per-trade limit"],
  balance: [400, "Not enough balance"],
  max_per_expiry: [400, "Over the per-round limit"],
  pool_limit: [409, "Pool limit reached"],
};

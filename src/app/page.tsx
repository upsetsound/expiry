"use client";
import { useEffect, useMemo, useRef, useState } from "react";
import { ASSETS, TICK, fetchSettlementFallback, twap, useMarket, type Asset } from "@/lib/feeds";
import {
  RULES,
  bsPrice,
  expectedMove,
  maxPayout,
  payout as payoutFor,
  pricingVol,
  quote,
  strikeLadder,
  yearsUntil,
  type Side,
} from "@/lib/pricing";
import { SALES_STOP_MS, formatCountdown, formatExpiry, nextExpiry, type Tenor } from "@/lib/schedule";
import { TOP_UP_BELOW, WEEK_MS, START_BALANCE, freshAccount, loadAccount, saveAccount, type Account, type Position } from "@/lib/store";

const CONTRACT: Record<Asset, number> = { BTC: 0.01, ETH: 0.1 };
const SETTLE_WINDOW_MS = 5 * 60_000;

const usd = (n: number, d = 2) =>
  n.toLocaleString(undefined, { style: "currency", currency: "USD", minimumFractionDigits: d, maximumFractionDigits: d });
const num = (n: number, d = 0) => n.toLocaleString(undefined, { minimumFractionDigits: d, maximumFractionDigits: d });
const pct = (n: number, d = 1) => `${(n * 100).toFixed(d)}%`;

function Mark({ size = 28 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 100 100" aria-hidden="true">
      <path d="M50 50 L50 12 A38 38 0 1 0 88 50 Z" fill="var(--mint)" stroke="var(--mint)" strokeWidth={6} strokeLinejoin="round" />
    </svg>
  );
}

export default function Home() {
  const market = useMarket();
  const [acct, setAcct] = useState<Account | null>(null);
  const [asset, setAsset] = useState<Asset>("BTC");
  const [tenor, setTenor] = useState<Tenor>("1h");
  const [side, setSide] = useState<Side>("call");
  const [strike, setStrike] = useState<number | null>(null);
  const [amount, setAmount] = useState("25");
  const [flash, setFlash] = useState<string | null>(null);
  const [resetArmed, setResetArmed] = useState(false);
  const settling = useRef<Set<string>>(new Set());
  const now = Date.now();

  useEffect(() => setAcct(loadAccount()), []);
  useEffect(() => {
    if (acct) saveAccount(acct);
  }, [acct]);

  const spot = market.price[asset];
  const sigma = pricingVol(market.implied[asset], market.realized[asset]);
  const expiry = nextExpiry(tenor, now);
  const T = yearsUntil(expiry, now);
  const em = spot ? expectedMove(spot, sigma, T) : 0;
  const ladderKey = `${asset}-${expiry}`;

  // Fix the strike ladder for an expiry the first time it is shown.
  useEffect(() => {
    if (!acct || !spot || acct.ladders[ladderKey]) return;
    const strikes = strikeLadder(spot, sigma, T, TICK[asset]);
    const cutoff = Date.now() - 2 * 24 * 60 * 60_000;
    setAcct((a) => {
      if (!a) return a;
      const kept = Object.fromEntries(Object.entries(a.ladders).filter(([k]) => Number(k.split("-")[1]) > cutoff));
      return { ...a, ladders: { ...kept, [ladderKey]: strikes } };
    });
  }, [acct, spot, sigma, T, ladderKey, asset]);

  const savedLadder = acct?.ladders[ladderKey];
  const ladder = useMemo(() => savedLadder ?? [], [savedLadder]);
  const atm = ladder.length ? ladder.reduce((b, k) => (spot && Math.abs(k - spot) < Math.abs(b - spot) ? k : b), ladder[0]) : null;

  useEffect(() => {
    if (strike !== null && !ladder.includes(strike)) setStrike(null);
  }, [ladder, strike]);

  // Settle expired positions: live 5-minute TWAP when this page saw the window, else Coinbase candles.
  useEffect(() => {
    if (!acct) return;
    const due = acct.positions.filter((p) => p.status === "open" && p.expiry <= now && !settling.current.has(p.id));
    for (const p of due) {
      settling.current.add(p.id);
      const from = p.expiry - SETTLE_WINDOW_MS;
      const live = twap(market.samples[p.asset], from, p.expiry);
      const finish = (price: number) => {
        setAcct((a) => {
          if (!a) return a;
          const pos = a.positions.find((x) => x.id === p.id);
          if (!pos || pos.status !== "open") return a;
          const paid = payoutFor(pos.side, price, pos.strike, pos.units, pos.premium);
          return {
            ...a,
            balance: a.balance + paid,
            pool: a.pool - paid,
            positions: a.positions.map((x) => (x.id === p.id ? { ...x, status: "settled", settle: price, payout: paid } : x)),
          };
        });
      };
      if (live.price && live.coverage >= 0.6) finish(live.price);
      else
        fetchSettlementFallback(p.asset, from, p.expiry).then((price) => {
          if (price) finish(price);
          else settling.current.delete(p.id); // retry on a later tick
        });
    }
  }, [acct, now, market.samples]);

  const amt = Math.max(0, parseFloat(amount) || 0);
  const salesOpen = expiry - now > SALES_STOP_MS[tenor];

  const ticket = useMemo(() => {
    if (!spot || strike === null || !acct) return null;
    const perUnit = quote(side, spot, strike, sigma, T);
    const units = perUnit > 0 ? amt / perUnit : 0;
    const breakeven = side === "call" ? strike + perUnit : strike - perUnit;
    const target = side === "call" ? strike + em : strike - em;
    const ifTarget = payoutFor(side, target, strike, units, amt);
    const cap = RULES.payoutCap * amt;
    const mp = maxPayout(side, spot, strike, units, amt, em);

    const open = acct.positions.filter((p) => p.status === "open");
    const thisExpiry = open.filter((p) => p.asset === asset && p.expiry === expiry);
    const spentHere = thisExpiry.reduce((s, p) => s + p.premium, 0);
    const sideLiab = thisExpiry.filter((p) => p.side === side).reduce((s, p) => s + p.maxPayout, 0);
    const totalLiab = open.reduce((s, p) => s + p.maxPayout, 0);

    let block: string | null = null;
    if (!salesOpen) block = "Sales closed for this expiry";
    else if (amt < RULES.minPremium) block = `Minimum is ${usd(RULES.minPremium, 0)}`;
    else if (amt > RULES.maxPremiumPerPosition) block = `Max ${usd(RULES.maxPremiumPerPosition, 0)} per position`;
    else if (spentHere + amt > RULES.maxPremiumPerExpiry) block = `Max ${usd(RULES.maxPremiumPerExpiry, 0)} per expiry (${usd(spentHere, 0)} used)`;
    else if (amt > acct.balance) block = "Not enough balance";
    else if (sideLiab + mp > RULES.sidePoolShare * acct.pool) block = "Pool limit reached for this side";
    else if (totalLiab + mp > RULES.totalPoolShare * acct.pool) block = "Pool limit reached";
    return { perUnit, units, breakeven, target, ifTarget, cap, mp, block };
  }, [spot, strike, acct, side, sigma, T, amt, em, asset, expiry, salesOpen]);

  function buy() {
    if (!acct || !ticket || ticket.block || strike === null || !spot) return;
    const key = `${asset}-${expiry}`;
    const day = new Date().toISOString().slice(0, 10);
    const pd = acct.pointsDay.day === day ? acct.pointsDay : { day, count: 0 };
    const earns = !acct.tradedExpiries.includes(key) && pd.count < 24;
    const pos: Position = {
      id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      asset,
      side,
      strike,
      tenor,
      expiry,
      premium: amt,
      units: ticket.units,
      maxPayout: ticket.mp,
      boughtAt: Date.now(),
      spotAtBuy: spot,
      status: "open",
    };
    setAcct({
      ...acct,
      balance: acct.balance - amt,
      pool: acct.pool + amt,
      points: acct.points + (earns ? 10 : 0),
      pointsDay: earns ? { day, count: pd.count + 1 } : pd,
      tradedExpiries: earns ? [...acct.tradedExpiries, key] : acct.tradedExpiries,
      positions: [pos, ...acct.positions],
    });
    setFlash(`Bought ${asset} ${num(strike)} ${side} for ${usd(amt)}${earns ? " · +10 points" : ""}`);
    setTimeout(() => setFlash(null), 3000);
  }

  const canTopUp = acct && acct.balance < TOP_UP_BELOW && now - acct.lastTopUp > WEEK_MS;
  const open = acct?.positions.filter((p) => p.status === "open") ?? [];
  const settled = acct?.positions.filter((p) => p.status === "settled") ?? [];
  const realizedPnl = settled.reduce((s, p) => s + (p.payout ?? 0) - p.premium, 0);

  return (
    <main className="wrap">
      <header className="top">
        <div className="brand">
          <Mark />
          <span className="word">expiry</span>
          <span className="badge">Paper mode</span>
        </div>
        <dl className="stats">
          <div>
            <dt>Balance</dt>
            <dd>{acct ? usd(acct.balance) : "—"}</dd>
          </div>
          <div>
            <dt>House pool (simulated)</dt>
            <dd>{acct ? usd(acct.pool, 0) : "—"}</dd>
          </div>
          <div>
            <dt>Points</dt>
            <dd>{acct ? num(acct.points) : "—"}</dd>
          </div>
        </dl>
      </header>

      <div className="grid">
        <section className="card">
          <div className="row between">
            <div className="seg" role="group" aria-label="Asset">
              {ASSETS.map((a) => (
                <button key={a} className={a === asset ? "on" : ""} onClick={() => setAsset(a)}>
                  {a}
                </button>
              ))}
            </div>
            <div className="seg" role="group" aria-label="Expiry">
              {(["1h", "1d"] as Tenor[]).map((t) => (
                <button key={t} className={t === tenor ? "on" : ""} onClick={() => setTenor(t)}>
                  {t === "1h" ? "1 hour" : "1 day"}
                </button>
              ))}
            </div>
          </div>

          <div className="price">
            <span className="big">{spot ? usd(spot, asset === "BTC" ? 0 : 2) : "Connecting…"}</span>
            <span className="muted">
              <span className={`dot ${market.venues[asset] >= 2 ? "ok" : ""}`} aria-hidden="true" />
              {market.venues[asset]} of 4 venues
            </span>
          </div>

          <div className="meta">
            <div>
              <span className="muted">Expires</span>
              <strong>{formatExpiry(expiry)}</strong>
            </div>
            <div>
              <span className="muted">Time left</span>
              <strong>{formatCountdown(expiry - now)}</strong>
            </div>
            <div>
              <span className="muted">Pricing vol</span>
              <strong>{pct(sigma, 0)}</strong>
            </div>
            <div>
              <span className="muted">Expected move</span>
              <strong>{spot ? `±${usd(em, 0)}` : "—"}</strong>
            </div>
          </div>
          <p className="fine">
            Vol = max(Deribit DVOL {market.implied[asset] ? pct(market.implied[asset]!, 0) : "n/a"}, 1.25 × realized{" "}
            {pct(market.realized[asset], 0)}, 35% floor). Prices include a 10% house edge.
          </p>

          <div className="seg wide" role="group" aria-label="Option type">
            <button className={side === "call" ? "on call" : ""} onClick={() => setSide("call")}>
              Call · price goes up
            </button>
            <button className={side === "put" ? "on put" : ""} onClick={() => setSide("put")}>
              Put · price goes down
            </button>
          </div>

          <table className="ladder">
            <thead>
              <tr>
                <th scope="col">Strike</th>
                <th scope="col">From spot</th>
                <th scope="col">Per {CONTRACT[asset]} {asset}</th>
                <th scope="col">Breakeven</th>
              </tr>
            </thead>
            <tbody>
              {ladder.map((k) => {
                const per = spot ? quote(side, spot, k, sigma, T) : 0;
                const be = side === "call" ? k + per : k - per;
                return (
                  <tr key={k} className={`${k === strike ? "sel" : ""} ${k === atm ? "atm" : ""}`}>
                    <td>
                      <button className="strike" onClick={() => setStrike(k)} aria-pressed={k === strike}>
                        {num(k)}
                      </button>
                    </td>
                    <td>{spot ? `${k >= spot ? "+" : ""}${pct(k / spot - 1, 2)}` : "—"}</td>
                    <td>{spot ? usd(per * CONTRACT[asset]) : "—"}</td>
                    <td>{spot ? num(be, asset === "BTC" ? 0 : 1) : "—"}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </section>

        <div className="col">
          <section className="card">
            <h2>Ticket</h2>
            {strike === null || !ticket ? (
              <p className="muted">Pick a strike to buy a {side}.</p>
            ) : (
              <>
                <p className="ticket-title">
                  {asset} {num(strike)} <span className={side}>{side}</span> · {formatExpiry(expiry)}
                </p>
                <label className="field">
                  <span>Amount (USD)</span>
                  <input inputMode="decimal" value={amount} onChange={(e) => setAmount(e.target.value)} />
                </label>
                <div className="chips">
                  {[10, 25, 50, 100, 250].map((v) => (
                    <button key={v} onClick={() => setAmount(String(v))}>
                      ${v}
                    </button>
                  ))}
                </div>
                <dl className="kv">
                  <div>
                    <dt>Size</dt>
                    <dd>
                      {num(ticket.units, asset === "BTC" ? 5 : 4)} {asset}
                    </dd>
                  </div>
                  <div>
                    <dt>Breakeven</dt>
                    <dd>{num(ticket.breakeven, asset === "BTC" ? 0 : 1)}</dd>
                  </div>
                  <div>
                    <dt>If {asset} settles at {num(ticket.target)}</dt>
                    <dd>{usd(ticket.ifTarget)}</dd>
                  </div>
                  <div>
                    <dt>Max payout (20×)</dt>
                    <dd>{usd(ticket.cap, 0)}</dd>
                  </div>
                  <div>
                    <dt>Max loss</dt>
                    <dd>{usd(amt)}</dd>
                  </div>
                </dl>
                <button className="buy" onClick={buy} disabled={!!ticket.block}>
                  {ticket.block ?? `Buy ${side} for ${usd(amt)}`}
                </button>
              </>
            )}
            {flash && <p className="flash" role="status">{flash}</p>}
            {canTopUp && (
              <button
                className="ghost"
                onClick={() => acct && setAcct({ ...acct, balance: acct.balance + START_BALANCE, lastTopUp: Date.now() })}
              >
                Claim weekly {usd(START_BALANCE, 0)} top-up
              </button>
            )}
          </section>

          <section className="card">
            <h2>Open ({open.length})</h2>
            {open.length === 0 && <p className="muted">No open options.</p>}
            <ul className="list">
              {open.map((p) => {
                const s = market.price[p.asset];
                const value = s ? bsPrice(p.side, s, p.strike, sigma, yearsUntil(p.expiry, now)) * p.units : null;
                return (
                  <li key={p.id}>
                    <div>
                      <strong>
                        {p.asset} {num(p.strike)} <span className={p.side}>{p.side}</span>
                      </strong>
                      <span className="muted">
                        {p.expiry > now ? `expires in ${formatCountdown(p.expiry - now)}` : "settling…"}
                      </span>
                    </div>
                    <div className="right">
                      <span>{usd(p.premium)} paid</span>
                      <span className="muted">worth ~{value !== null ? usd(Math.min(value, RULES.payoutCap * p.premium)) : "—"}</span>
                    </div>
                  </li>
                );
              })}
            </ul>
          </section>

          <section className="card">
            <div className="row between">
              <h2>Settled ({settled.length})</h2>
              {settled.length > 0 && (
                <span className={realizedPnl >= 0 ? "pos" : "neg"}>
                  {realizedPnl >= 0 ? "+" : ""}
                  {usd(realizedPnl)}
                </span>
              )}
            </div>
            {settled.length === 0 && <p className="muted">Nothing settled yet.</p>}
            <ul className="list">
              {settled.slice(0, 20).map((p) => {
                const pnl = (p.payout ?? 0) - p.premium;
                return (
                  <li key={p.id}>
                    <div>
                      <strong>
                        {p.asset} {num(p.strike)} <span className={p.side}>{p.side}</span>
                      </strong>
                      <span className="muted">settled {num(p.settle ?? 0, p.asset === "BTC" ? 0 : 2)}</span>
                    </div>
                    <div className="right">
                      <span className={pnl >= 0 ? "pos" : "neg"}>
                        {pnl >= 0 ? "+" : ""}
                        {usd(pnl)}
                      </span>
                      <span className="muted">paid {usd(p.payout ?? 0)}</span>
                    </div>
                  </li>
                );
              })}
            </ul>
          </section>

          <button
            className="ghost small"
            onClick={() => {
              if (resetArmed) {
                setAcct(freshAccount());
                setResetArmed(false);
              } else {
                setResetArmed(true);
                setTimeout(() => setResetArmed(false), 4000);
              }
            }}
          >
            {resetArmed ? "Click again to reset everything" : "Reset paper account"}
          </button>
        </div>
      </div>

      <footer className="foot">
        Paper trading only. No real money, wallets or tokens. Settlement = 5-minute average of the median price across
        Coinbase, Binance, OKX and Hyperliquid.
      </footer>
    </main>
  );
}


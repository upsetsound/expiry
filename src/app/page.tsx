"use client";
import { useEffect, useMemo, useRef, useState } from "react";
import Chart, { LOOKBACKS } from "./Chart";
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
import { START_BALANCE, START_POOL, TOP_UP_BELOW, WEEK_MS, freshAccount, loadAccount, saveAccount, type Account, type Position } from "@/lib/store";

const SETTLE_WINDOW_MS = 5 * 60_000;
const DAY_MS = 24 * 60 * 60_000;
const ICON: Record<Asset, string> = { BTC: "₿", ETH: "Ξ" };

const usd = (n: number, d = 2) =>
  n.toLocaleString(undefined, { style: "currency", currency: "USD", minimumFractionDigits: d, maximumFractionDigits: d });
const compact = (n: number) =>
  n.toLocaleString(undefined, { style: "currency", currency: "USD", notation: "compact", maximumFractionDigits: 2 });
const num = (n: number, d = 0) => n.toLocaleString(undefined, { minimumFractionDigits: d, maximumFractionDigits: d });
const pct = (n: number, d = 1) => `${(n * 100).toFixed(d)}%`;
const signed = (n: number, f: (x: number) => string) => `${n >= 0 ? "+" : "−"}${f(Math.abs(n))}`;

type View = "trade" | "portfolio" | "house" | "leaderboard";
type BottomTab = "positions" | "history" | "leaderboard" | "status";
type Menu = "asset" | "expiry" | "range" | "more" | null;

function Mark({ size = 22 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 100 100" aria-hidden="true">
      <path d="M50 50 L50 12 A38 38 0 1 0 88 50 Z" fill="var(--mint)" stroke="var(--mint)" strokeWidth={6} strokeLinejoin="round" />
    </svg>
  );
}

function Chevron({ up = false }: { up?: boolean }) {
  return (
    <svg width="12" height="12" viewBox="0 0 24 24" aria-hidden="true" style={{ transform: up ? "rotate(180deg)" : undefined }}>
      <path d="M6 9l6 6 6-6" fill="none" stroke="currentColor" strokeWidth={2.2} strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

export default function Home() {
  const market = useMarket();
  const [acct, setAcct] = useState<Account | null>(null);
  const [view, setView] = useState<View>("trade");
  const [bottom, setBottom] = useState<BottomTab>("positions");
  const [menu, setMenu] = useState<Menu>(null);
  const [asset, setAsset] = useState<Asset>("BTC");
  const [tenor, setTenor] = useState<Tenor>("1h");
  const [lookback, setLookback] = useState(1);
  const [side, setSide] = useState<Side>("call");
  const [strike, setStrike] = useState<number | null>(null);
  const [amount, setAmount] = useState("25");
  const [flash, setFlash] = useState<string | null>(null);
  const [resetArmed, setResetArmed] = useState(false);
  const [equityOpen, setEquityOpen] = useState(false);
  const settling = useRef<Set<string>>(new Set());
  const now = Date.now();

  useEffect(() => setAcct(loadAccount()), []);
  useEffect(() => {
    if (acct) saveAccount(acct);
  }, [acct]);

  // Close any open dropdown on an outside click or Escape.
  useEffect(() => {
    if (!menu) return;
    const close = (e: MouseEvent) => {
      if (!(e.target as HTMLElement).closest("[data-menu]")) setMenu(null);
    };
    const esc = (e: KeyboardEvent) => e.key === "Escape" && setMenu(null);
    document.addEventListener("mousedown", close);
    document.addEventListener("keydown", esc);
    return () => {
      document.removeEventListener("mousedown", close);
      document.removeEventListener("keydown", esc);
    };
  }, [menu]);

  const spot = market.price[asset];
  const sigma = pricingVol(market.implied[asset], market.realized[asset]);
  const expiry = nextExpiry(tenor, now);
  const T = yearsUntil(expiry, now);
  const em = spot ? expectedMove(spot, sigma, T) : 0;
  const ladderKey = `${asset}-${expiry}`;
  const dec = asset === "BTC" ? 0 : 2;

  // Fix the strike ladder for an expiry the first time it is shown; drop ladders older than 2 days.
  useEffect(() => {
    if (!acct || !spot || acct.ladders[ladderKey]) return;
    const strikes = strikeLadder(spot, sigma, T, TICK[asset]);
    const cutoff = Date.now() - 2 * DAY_MS;
    setAcct((a) => {
      if (!a) return a;
      const kept = Object.fromEntries(Object.entries(a.ladders).filter(([k]) => Number(k.split("-")[1]) > cutoff));
      return { ...a, ladders: { ...kept, [ladderKey]: strikes } };
    });
  }, [acct, spot, sigma, T, ladderKey, asset]);

  const savedLadder = acct?.ladders[ladderKey];
  const ladder = useMemo(() => savedLadder ?? [], [savedLadder]);
  const atm = ladder.length && spot ? ladder.reduce((b, k) => (Math.abs(k - spot) < Math.abs(b - spot) ? k : b), ladder[0]) : null;

  useEffect(() => {
    if (strike !== null && !ladder.includes(strike)) setStrike(null);
    if (strike === null && atm !== null) setStrike(atm);
  }, [ladder, strike, atm]);

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
          else settling.current.delete(p.id);
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
    const mp = maxPayout(side, spot, strike, units, amt, em);

    const openPos = acct.positions.filter((p) => p.status === "open");
    const thisExpiry = openPos.filter((p) => p.asset === asset && p.expiry === expiry);
    const spentHere = thisExpiry.reduce((s, p) => s + p.premium, 0);
    const sideLiab = thisExpiry.filter((p) => p.side === side).reduce((s, p) => s + p.maxPayout, 0);
    const totalLiab = openPos.reduce((s, p) => s + p.maxPayout, 0);

    let block: string | null = null;
    if (!salesOpen) block = "Sales closed for this expiry";
    else if (amt < RULES.minPremium) block = `Minimum ${usd(RULES.minPremium, 0)}`;
    else if (amt > RULES.maxPremiumPerPosition) block = `Max ${usd(RULES.maxPremiumPerPosition, 0)} per position`;
    else if (spentHere + amt > RULES.maxPremiumPerExpiry) block = `Max ${usd(RULES.maxPremiumPerExpiry, 0)} per expiry`;
    else if (amt > acct.balance) block = "Not enough balance";
    else if (sideLiab + mp > RULES.sidePoolShare * acct.pool) block = "Pool limit reached for this side";
    else if (totalLiab + mp > RULES.totalPoolShare * acct.pool) block = "Pool limit reached";
    const room = Math.max(0, Math.min(RULES.maxPremiumPerPosition, RULES.maxPremiumPerExpiry - spentHere, acct.balance));
    return { perUnit, units, breakeven, target, ifTarget, mp, block, room };
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
    setFlash(`Bought ${asset} ${num(strike)} ${side} · ${usd(amt)}${earns ? " · +10 pts" : ""}`);
    setTimeout(() => setFlash(null), 3000);
  }

  // Derived numbers for the header, panels and tabs.
  const positions = acct?.positions ?? [];
  const open = positions.filter((p) => p.status === "open");
  const settled = positions.filter((p) => p.status === "settled");
  const markValue = (p: Position) => {
    const s = market.price[p.asset];
    if (!s) return null;
    const sg = pricingVol(market.implied[p.asset], market.realized[p.asset]);
    return Math.min(bsPrice(p.side, s, p.strike, sg, yearsUntil(p.expiry, now)) * p.units, RULES.payoutCap * p.premium);
  };
  const inOptions = open.reduce((s, p) => s + p.premium, 0);
  const openValue = open.reduce((s, p) => s + (markValue(p) ?? 0), 0);
  const openPnl = openValue - inOptions;
  const realizedPnl = settled.reduce((s, p) => s + (p.payout ?? 0) - p.premium, 0);
  const assetOpen = open.filter((p) => p.asset === asset);
  const callOi = assetOpen.filter((p) => p.side === "call").reduce((s, p) => s + p.premium, 0);
  const putOi = assetOpen.filter((p) => p.side === "put").reduce((s, p) => s + p.premium, 0);
  const vol24 = positions.filter((p) => p.asset === asset && now - p.boughtAt < DAY_MS).reduce((s, p) => s + p.premium, 0);
  const change = (a: Asset) => {
    const p = market.price[a];
    const o = market.open24[a];
    return p && o ? p / o - 1 : null;
  };
  const tape = positions.slice(0, 14);
  const canTopUp = acct && acct.balance < TOP_UP_BELOW && now - acct.lastTopUp > WEEK_MS;
  const premiumsIn = positions.reduce((s, p) => s + p.premium, 0);
  const paidOut = settled.reduce((s, p) => s + (p.payout ?? 0), 0);

  const series = useMemo(() => {
    const live = market.samples[asset];
    const first = live.length ? live[0].t : Infinity;
    return [...market.history[asset].filter((h) => h.t < first), ...live];
  }, [market.samples, market.history, asset]);

  const live = market.venues[asset] >= 2;

  function resetAccount() {
    if (resetArmed) {
      setAcct(freshAccount());
      setResetArmed(false);
      setMenu(null);
    } else {
      setResetArmed(true);
      setTimeout(() => setResetArmed(false), 4000);
    }
  }

  const positionRows = (
    <table className="tbl">
      <thead>
        <tr>
          <th scope="col">Option</th>
          <th scope="col">Expiry</th>
          <th scope="col">Size</th>
          <th scope="col">Paid</th>
          <th scope="col">Value</th>
          <th scope="col">P/L</th>
          <th scope="col">Breakeven</th>
        </tr>
      </thead>
      <tbody>
        {open.map((p) => {
          const v = markValue(p);
          const per = p.premium / p.units;
          return (
            <tr key={p.id}>
              <td>
                <strong>{p.asset}</strong> {num(p.strike)} <span className={p.side}>{p.side === "call" ? "Call" : "Put"}</span>
              </td>
              <td>{p.expiry > now ? formatCountdown(p.expiry - now) : "Settling…"}</td>
              <td>
                {num(p.units, p.asset === "BTC" ? 5 : 4)} {p.asset}
              </td>
              <td>{usd(p.premium)}</td>
              <td>{v !== null ? usd(v) : "—"}</td>
              <td className={v !== null && v - p.premium >= 0 ? "pos" : "neg"}>{v !== null ? signed(v - p.premium, (x) => usd(x)) : "—"}</td>
              <td>{num(p.side === "call" ? p.strike + per : p.strike - per, p.asset === "BTC" ? 0 : 1)}</td>
            </tr>
          );
        })}
      </tbody>
    </table>
  );

  const historyRows = (
    <table className="tbl">
      <thead>
        <tr>
          <th scope="col">Option</th>
          <th scope="col">Expired</th>
          <th scope="col">Settled at</th>
          <th scope="col">Paid</th>
          <th scope="col">Payout</th>
          <th scope="col">P/L</th>
        </tr>
      </thead>
      <tbody>
        {settled.map((p) => {
          const pnl = (p.payout ?? 0) - p.premium;
          return (
            <tr key={p.id}>
              <td>
                <strong>{p.asset}</strong> {num(p.strike)} <span className={p.side}>{p.side === "call" ? "Call" : "Put"}</span>
              </td>
              <td>{formatExpiry(p.expiry)}</td>
              <td>{num(p.settle ?? 0, p.asset === "BTC" ? 0 : 2)}</td>
              <td>{usd(p.premium)}</td>
              <td>{usd(p.payout ?? 0)}</td>
              <td className={pnl >= 0 ? "pos" : "neg"}>{signed(pnl, (x) => usd(x))}</td>
            </tr>
          );
        })}
      </tbody>
    </table>
  );

  const leaderboard = (
    <div className="empty">
      <p>The public leaderboard goes live with accounts.</p>
      <p className="muted">
        Your paper stats so far: {settled.length} settled · {signed(realizedPnl, (x) => usd(x))} realized · {num(acct?.points ?? 0)} points
      </p>
    </div>
  );

  const status = (
    <dl className="status">
      <div>
        <dt>Price venues</dt>
        <dd>
          {market.venues.BTC} of 4 live (BTC) · {market.venues.ETH} of 4 live (ETH)
        </dd>
      </div>
      <div>
        <dt>Pricing vol ({asset})</dt>
        <dd>
          {pct(sigma, 0)} = max(DVOL {market.implied[asset] ? pct(market.implied[asset]!, 0) : "n/a"}, 1.25 × realized{" "}
          {pct(market.realized[asset], 0)}, 35% floor)
        </dd>
      </div>
      <div>
        <dt>House edge</dt>
        <dd>{pct(RULES.baseEdge, 0)} over Black-Scholes fair value</dd>
      </div>
      <div>
        <dt>Settlement</dt>
        <dd>5-minute average of the median across Coinbase, Binance, OKX, Hyperliquid</dd>
      </div>
      <div>
        <dt>Limits</dt>
        <dd>
          {usd(RULES.maxPremiumPerPosition, 0)}/position · {usd(RULES.maxPremiumPerExpiry, 0)}/expiry · {RULES.payoutCap}× payout cap
        </dd>
      </div>
    </dl>
  );

  return (
    <div className="app">
      <nav className="nav" aria-label="Main">
        <div className="nav-left">
          <span className="brand">
            <Mark />
            <span className="word">expiry</span>
          </span>
          {(["trade", "portfolio", "house", "leaderboard"] as View[]).map((v) => (
            <button key={v} className={`tab ${view === v ? "on" : ""}`} onClick={() => setView(v)} aria-current={view === v ? "page" : undefined}>
              {v[0].toUpperCase() + v.slice(1)}
            </button>
          ))}
          <div className="dd" data-menu>
            <button className="tab" onClick={() => setMenu(menu === "more" ? null : "more")} aria-expanded={menu === "more"}>
              More <Chevron up={menu === "more"} />
            </button>
            {menu === "more" && (
              <div className="menu">
                <button onClick={() => { setView("house"); setMenu(null); }}>How the pool works</button>
                <button onClick={() => { setBottom("status"); setView("trade"); setMenu(null); }}>Pricing &amp; status</button>
                <button onClick={resetAccount}>{resetArmed ? "Click again to reset" : "Reset paper account"}</button>
              </div>
            )}
          </div>
        </div>
        <div className="nav-right">
          <span className="paper">Paper</span>
          <span className="navstat">
            <span className="muted">Balance</span> {acct ? usd(acct.balance) : "—"}
          </span>
          <span className="navstat">
            <span className="muted">Points</span> {acct ? num(acct.points) : "—"}
          </span>
          {canTopUp && (
            <button className="tab" onClick={() => acct && setAcct({ ...acct, balance: acct.balance + START_BALANCE, lastTopUp: Date.now() })}>
              Top up
            </button>
          )}
        </div>
      </nav>

      {view === "trade" && (
        <div className="trade">
          <section className="main">
            <div className="bar">
              <div className="dd" data-menu>
                <button className="pill asset" onClick={() => setMenu(menu === "asset" ? null : "asset")} aria-expanded={menu === "asset"}>
                  <span className="coin" aria-hidden="true">{ICON[asset]}</span>
                  <strong>{asset}</strong>
                  <span className="sep" aria-hidden="true" />
                  <span className="px">{spot ? usd(spot, 2) : "—"}</span>
                  {change(asset) !== null && <span className={change(asset)! >= 0 ? "pos" : "neg"}>{signed(change(asset)!, (x) => pct(x, 2))}</span>}
                  <Chevron up={menu === "asset"} />
                </button>
                {menu === "asset" && (
                  <div className="menu wide">
                    {ASSETS.map((a) => (
                      <button key={a} className={a === asset ? "on" : ""} onClick={() => { setAsset(a); setStrike(null); setMenu(null); }}>
                        <span className="coin" aria-hidden="true">{ICON[a]}</span>
                        <strong>{a}</strong>
                        <span className="grow" />
                        <span>{market.price[a] ? usd(market.price[a]!, 2) : "—"}</span>
                        {change(a) !== null && <span className={change(a)! >= 0 ? "pos" : "neg"}>{signed(change(a)!, (x) => pct(x, 2))}</span>}
                      </button>
                    ))}
                  </div>
                )}
              </div>

              <div className="pill stats">
                <span className="stat">
                  <span className="lbl">Vol 24h</span> {compact(vol24)}
                </span>
                <span className="stat">
                  <span className="lbl">Call OI</span> {compact(callOi)}
                </span>
                <span className="stat">
                  <span className="lbl">Put OI</span> {compact(putOi)}
                </span>
                <div className="dd stat" data-menu>
                  <button className="ddbtn" onClick={() => setMenu(menu === "expiry" ? null : "expiry")} aria-expanded={menu === "expiry"}>
                    <span className="lbl">Expiry</span> {tenor === "1h" ? "1H" : "1D"} · {formatCountdown(expiry - now)} <Chevron up={menu === "expiry"} />
                  </button>
                  {menu === "expiry" && (
                    <div className="menu">
                      {(["1h", "1d"] as Tenor[]).map((t) => (
                        <button key={t} className={t === tenor ? "on" : ""} onClick={() => { setTenor(t); setStrike(null); setMenu(null); }}>
                          {t === "1h" ? "1 hour" : "1 day"} <span className="muted">· {formatExpiry(nextExpiry(t, now))}</span>
                        </button>
                      ))}
                    </div>
                  )}
                </div>
                <div className="dd stat" data-menu>
                  <button className="ddbtn" onClick={() => setMenu(menu === "range" ? null : "range")} aria-expanded={menu === "range"}>
                    {LOOKBACKS[lookback].label} <Chevron up={menu === "range"} />
                  </button>
                  {menu === "range" && (
                    <div className="menu">
                      {LOOKBACKS.map((l, i) => (
                        <button key={l.label} className={i === lookback ? "on" : ""} onClick={() => { setLookback(i); setMenu(null); }}>
                          {l.label}
                        </button>
                      ))}
                    </div>
                  )}
                </div>
                <span className={`stat live ${live ? "" : "off"}`}>{live ? "LIVE" : "CONNECTING"}</span>
              </div>
            </div>

            <div className="chartbox">
              <Chart
                series={series}
                now={now}
                spot={spot}
                sigma={sigma}
                expiry={expiry}
                side={side}
                strike={strike}
                breakeven={ticket ? ticket.breakeven : null}
                positions={open.filter((p) => p.asset === asset && p.expiry === expiry).map((p) => ({ id: p.id, side: p.side, strike: p.strike, premium: p.premium }))}
                decimals={dec}
                lookback={lookback}
              />
            </div>
          </section>

          <aside className="side" aria-label="Trade">
            <div className="box">
              <button className="eq-head" onClick={() => setEquityOpen(!equityOpen)} aria-expanded={equityOpen}>
                <Chevron up={equityOpen} /> <span>Account equity</span>
                <span className="grow" />
                <strong>{acct ? usd(acct.balance + openValue) : "—"}</strong>
              </button>
              {equityOpen && (
                <dl className="kv">
                  <div>
                    <dt>Available to trade</dt>
                    <dd>{acct ? usd(acct.balance) : "—"}</dd>
                  </div>
                  <div>
                    <dt>In options</dt>
                    <dd>{usd(inOptions)}</dd>
                  </div>
                  <div>
                    <dt>Open P/L</dt>
                    <dd className={openPnl >= 0 ? "pos" : "neg"}>{open.length ? signed(openPnl, (x) => usd(x)) : "—"}</dd>
                  </div>
                </dl>
              )}
            </div>

            <div className="toggle" role="group" aria-label="Option type">
              <button className={side === "call" ? "on call" : ""} onClick={() => setSide("call")}>
                ↗ Call
              </button>
              <button className={side === "put" ? "on put" : ""} onClick={() => setSide("put")}>
                ↘ Put
              </button>
            </div>

            <div className="field-head">
              <span className="muted">Strike</span>
              <span className="lbl">Cost per {asset === "BTC" ? "0.01" : "0.1"} · pays if</span>
            </div>
            <div className="strikes" role="listbox" aria-label="Strike">
              {[...ladder].reverse().map((k) => {
                const per = spot ? quote(side, spot, k, sigma, T) : 0;
                const unit = asset === "BTC" ? 0.01 : 0.1;
                const itm = spot ? (side === "call" ? k < spot : k > spot) : false;
                return (
                  <button
                    key={k}
                    role="option"
                    aria-selected={k === strike}
                    className={`strike-row ${k === strike ? "on" : ""} ${k === atm ? "atm" : ""}`}
                    onClick={() => setStrike(k)}
                  >
                    <span className="k">{num(k)}</span>
                    <span className="muted small">{spot ? signed(k / spot - 1, (x) => pct(x, 2)) : ""}</span>
                    <span className="grow" />
                    <span>{spot ? usd(per * unit) : "—"}</span>
                    <span className="muted small">
                      {side === "call" ? ">" : "<"} {num(side === "call" ? k + per : k - per, asset === "BTC" ? 0 : 1)}
                    </span>
                    {itm && <span className="itm">ITM</span>}
                  </button>
                );
              })}
            </div>

            <div className="field-head">
              <span className="lbl">Premium (USDC)</span>
            </div>
            <div className="amount">
              <button onClick={() => setAmount(String(Math.max(1, Math.round(amt / 2))))}>½×</button>
              <button onClick={() => setAmount(String(Math.round(amt * 2)))}>2×</button>
              <button onClick={() => ticket && setAmount(String(Math.floor(ticket.room)))}>Max</button>
              <input inputMode="decimal" aria-label="Premium in USDC" value={amount} onChange={(e) => setAmount(e.target.value)} />
            </div>

            {ticket && strike !== null && (
              <dl className="kv summary">
                <div>
                  <dt>Breakeven</dt>
                  <dd>{num(ticket.breakeven, asset === "BTC" ? 0 : 1)}</dd>
                </div>
                <div>
                  <dt>If {asset} settles {num(ticket.target)}</dt>
                  <dd className="pos">{usd(ticket.ifTarget)}</dd>
                </div>
                <div>
                  <dt>Max payout</dt>
                  <dd>
                    {usd(RULES.payoutCap * amt, 0)} <span className="muted">({RULES.payoutCap}×)</span>
                  </dd>
                </div>
              </dl>
            )}

            <button className={`buy ${side}`} onClick={buy} disabled={!ticket || !!ticket.block}>
              {!ticket ? "Waiting for price…" : ticket.block ?? `Buy ${side === "call" ? "Call" : "Put"} · ${usd(amt)}`}
            </button>
            {flash && (
              <p className="flash" role="status">
                {flash}
              </p>
            )}
            <p className="fine">Paper money. Max loss is the premium you pay.</p>
          </aside>

          <section className="bottom">
            <div className="btabs">
              {(["positions", "history", "leaderboard", "status"] as BottomTab[]).map((b) => (
                <button key={b} className={`btab ${bottom === b ? "on" : ""}`} onClick={() => setBottom(b)}>
                  {b[0].toUpperCase() + b.slice(1)}
                  {b === "positions" && open.length > 0 && <span className="count">{open.length}</span>}
                </button>
              ))}
              <div className={`tape ${tape.length === 0 ? "empty-tape" : ""}`} aria-label="Recent trades">
                {tape.length === 0 ? (
                  <span className="muted small">No trades yet</span>
                ) : (
                  <div className="tape-track">
                    {[...tape, ...tape].map((p, i) => {
                      const won = p.status === "settled" && (p.payout ?? 0) > p.premium;
                      const lost = p.status === "settled" && !won;
                      return (
                        <span key={`${p.id}-${i}`} className={`chip ${p.side}`} aria-hidden={i >= tape.length}>
                          <span className="coin sm">{ICON[p.asset]}</span>
                          {p.status === "open" && <>{p.side === "call" ? "▲" : "▼"} {compact(p.premium)}</>}
                          {won && <span className="pos">+{compact((p.payout ?? 0) - p.premium)}</span>}
                          {lost && <span className="neg">−{compact(p.premium - (p.payout ?? 0))}</span>}
                        </span>
                      );
                    })}
                  </div>
                )}
              </div>
            </div>
            <div className="bbody">
              {bottom === "positions" && (open.length ? positionRows : <p className="empty">No open options. Pick a strike and buy a call or put.</p>)}
              {bottom === "history" && (settled.length ? historyRows : <p className="empty">Nothing settled yet.</p>)}
              {bottom === "leaderboard" && leaderboard}
              {bottom === "status" && status}
            </div>
          </section>
        </div>
      )}

      {view === "portfolio" && (
        <main className="page">
          <h1>Portfolio</h1>
          <div className="cards">
            <div className="card">
              <span className="lbl">Equity</span>
              <strong>{acct ? usd(acct.balance + openValue) : "—"}</strong>
            </div>
            <div className="card">
              <span className="lbl">Realized P/L</span>
              <strong className={realizedPnl >= 0 ? "pos" : "neg"}>{signed(realizedPnl, (x) => usd(x))}</strong>
            </div>
            <div className="card">
              <span className="lbl">Win rate</span>
              <strong>{settled.length ? pct(settled.filter((p) => (p.payout ?? 0) > p.premium).length / settled.length, 0) : "—"}</strong>
            </div>
            <div className="card">
              <span className="lbl">Points</span>
              <strong>{num(acct?.points ?? 0)}</strong>
            </div>
          </div>
          <h2>Open</h2>
          {open.length ? positionRows : <p className="empty">No open options.</p>}
          <h2>History</h2>
          {settled.length ? historyRows : <p className="empty">Nothing settled yet.</p>}
        </main>
      )}

      {view === "house" && (
        <main className="page">
          <h1>House pool</h1>
          <p className="lead">
            Premiums go into each expiry&apos;s escrow. At settlement, winners are paid from that escrow first, then from the pool, and whatever is left
            goes to the pool. In paper mode the pool is simulated and starts at {usd(START_POOL, 0)}.
          </p>
          <div className="cards">
            <div className="card">
              <span className="lbl">Pool balance</span>
              <strong>{acct ? usd(acct.pool, 0) : "—"}</strong>
            </div>
            <div className="card">
              <span className="lbl">Premiums in</span>
              <strong>{usd(premiumsIn, 0)}</strong>
            </div>
            <div className="card">
              <span className="lbl">Paid out</span>
              <strong>{usd(paidOut, 0)}</strong>
            </div>
            <div className="card">
              <span className="lbl">Pool P/L</span>
              <strong className={acct && acct.pool - START_POOL >= 0 ? "pos" : "neg"}>{acct ? signed(acct.pool - START_POOL, (x) => usd(x, 0)) : "—"}</strong>
            </div>
          </div>
          {status}
        </main>
      )}

      {view === "leaderboard" && (
        <main className="page">
          <h1>Leaderboard</h1>
          {leaderboard}
        </main>
      )}
    </div>
  );
}

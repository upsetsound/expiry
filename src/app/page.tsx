"use client";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import Chart from "./Chart";
import WinCard from "./WinCard";
import { ASSETS, TICK, isDemo, useMarket, type Asset, type MarketState } from "@/lib/feeds";
import { settledToast, useLocalAccount, type AccountApi, type Notify, type Position, type TapeItem, type Trader } from "@/lib/account";
import { useRoundResults, type RoundResult } from "@/lib/useRoundResults";
import { formatMultiple } from "@/lib/share";
import { sounds, useSound } from "@/lib/sound";
import { useLiveAccount } from "@/lib/liveAccount";
import {
  MAX_STRIKE_STEPS,
  RULES,
  expectedMove,
  liveMultiple,
  priceTicket,
  pricingVol,
  probITM,
  strikeStep,
  winMultiple,
  yearsUntil,
  type Side,
} from "@/lib/pricing";
import { TENORS, TENOR_LIST, formatClock, formatCountdown, nextExpiry, roundProgress, type Tenor } from "@/lib/schedule";
import { START_POOL } from "@/lib/store";

const DAY_MS = 24 * 60 * 60_000;
const DEFAULT_SPAN: Record<Tenor, number> = { "1m": 100_000, "5m": 6 * 60_000, "15m": 20 * 60_000, "1h": 75 * 60_000 };

const usd = (n: number, d = 2) =>
  n.toLocaleString(undefined, { style: "currency", currency: "USD", minimumFractionDigits: d, maximumFractionDigits: d });
const compact = (n: number) => n.toLocaleString(undefined, { style: "currency", currency: "USD", notation: "compact", maximumFractionDigits: 2 });
const num = (n: number, d = 0) => n.toLocaleString(undefined, { minimumFractionDigits: d, maximumFractionDigits: d });
const pct = (n: number, d = 1) => `${(n * 100).toFixed(d)}%`;
const signed = (n: number, f: (x: number) => string) => `${n >= 0 ? "+" : "−"}${f(Math.abs(n))}`;
const mult = formatMultiple;

type View = "trade" | "portfolio" | "house" | "leaderboard";
type BottomTab = "positions" | "history" | "leaderboard" | "status";

function Mark({ size = 20 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 100 100" aria-hidden="true">
      <path d="M50 50 L50 12 A38 38 0 1 0 88 50 Z" fill="var(--mint)" stroke="var(--mint)" strokeWidth={6} strokeLinejoin="round" />
    </svg>
  );
}

function Chevron({ dir = "down" }: { dir?: "down" | "up" | "left" | "right" }) {
  const rot = { down: 0, up: 180, left: 90, right: -90 }[dir];
  return (
    <svg width="12" height="12" viewBox="0 0 24 24" aria-hidden="true" style={{ transform: `rotate(${rot}deg)` }}>
      <path d="M6 9l6 6 6-6" fill="none" stroke="currentColor" strokeWidth={2.2} strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

function Speaker({ muted }: { muted: boolean }) {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" aria-hidden="true" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round">
      <path d="M11 5 6 9H3v6h3l5 4z" fill="currentColor" stroke="none" />
      {muted ? (
        <path d="m16 9 6 6m0-6-6 6" />
      ) : (
        <>
          <path d="M15.5 8.5a5 5 0 0 1 0 7" />
          <path d="M18.5 5.5a9 9 0 0 1 0 13" />
        </>
      )}
    </svg>
  );
}

function Coin({ asset, small = false }: { asset: Asset; small?: boolean }) {
  return (
    <span className={`coin ${small ? "sm" : ""}`} aria-hidden="true">
      {asset === "BTC" ? "₿" : "Ξ"}
    </span>
  );
}

// Avatar + @handle for a trader (tape, nav, leaderboard).
function Who({ trader, size = 16 }: { trader?: Trader | null; size?: number }) {
  const handle = trader?.handle;
  return (
    <span className="who">
      {trader?.avatar ? (
        // eslint-disable-next-line @next/next/no-img-element
        <img className="avatar" src={trader.avatar} alt="" width={size} height={size} referrerPolicy="no-referrer" />
      ) : (
        <span className="avatar ph" style={{ width: size, height: size }} aria-hidden="true">
          {(handle ?? "?").slice(0, 1).toUpperCase()}
        </span>
      )}
      <span className="handle">{handle ? `@${handle}` : "anon"}</span>
    </span>
  );
}

type Toast = { text: string; tone: "pos" | "neg" | "info" };
function useToast() {
  const [toast, setToast] = useState<Toast | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const say: Notify = useCallback((text, tone = "info") => {
    setToast({ text, tone });
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(() => setToast(null), 3500);
  }, []);
  return { toast, say };
}

// ?demo: local-only paper mode on simulated prices. Otherwise: multiplayer on Supabase.
export default function Home() {
  const [mode, setMode] = useState<"demo" | "live" | null>(null);
  useEffect(() => setMode(isDemo() ? "demo" : "live"), []);
  // Everything here depends on the clock and the browser, so render only in the browser.
  if (!mode) return <div className="app" />;
  return mode === "demo" ? <DemoApp /> : <LiveApp />;
}

function DemoApp() {
  const market = useMarket();
  const { toast, say } = useToast();
  const account = useLocalAccount(market);
  return <TradeApp market={market} account={account} toast={toast} say={say} />;
}

function LiveApp() {
  const market = useMarket();
  const { toast, say } = useToast();
  const account = useLiveAccount(say);
  return <TradeApp market={market} account={account} toast={toast} say={say} />;
}

function TradeApp({ market, account, toast, say }: { market: MarketState; account: AccountApi; toast: Toast | null; say: Notify }) {
  const live = account.mode === "live";
  const [view, setView] = useState<View>("trade");
  const [bottom, setBottom] = useState<BottomTab>("positions");
  const [menu, setMenu] = useState<"asset" | "more" | null>(null);
  const [asset, setAsset] = useState<Asset>("BTC");
  const [tenor, setTenor] = useState<Tenor>("1m");
  const [side, setSide] = useState<Side>("call");
  const [amount, setAmount] = useState("10");
  const [buying, setBuying] = useState(false);
  const [resetArmed, setResetArmed] = useState(false);
  const [equityOpen, setEquityOpen] = useState(false);
  const [follow, setFollow] = useState(true);
  const now = Date.now();

  useEffect(() => {
    if (!menu) return;
    const close = (e: MouseEvent) => !(e.target as HTMLElement).closest("[data-menu]") && setMenu(null);
    const esc = (e: KeyboardEvent) => e.key === "Escape" && setMenu(null);
    document.addEventListener("mousedown", close);
    document.addEventListener("keydown", esc);
    return () => {
      document.removeEventListener("mousedown", close);
      document.removeEventListener("keydown", esc);
    };
  }, [menu]);

  const spot = market.price[asset];
  // Live mode prices with the server's vol so the quote shown matches /api/buy; demo uses the browser's own.
  const sigmaFor = (a: Asset) => account.vol?.[a].sigma ?? pricingVol(market.implied[a], market.realized[a]);
  const impliedFor = (a: Asset) => (account.vol ? account.vol[a].implied : market.implied[a]);
  const realizedFor = (a: Asset) => (account.vol ? account.vol[a].realized : market.realized[a]);
  const sigma = sigmaFor(asset);
  const expiry = nextExpiry(tenor, now);
  const T = yearsUntil(expiry, now);
  const em = spot ? expectedMove(spot, sigma, T) : 0;
  const dec = asset === "BTC" ? 0 : 2;

  // Strikes are steps away from the at-the-money strike, so they follow the price.
  // Step = a round number near half an expected move (at least one tick).
  const step = useMemo(() => strikeStep(em, TICK[asset]), [em, asset]);
  const MAX_OFF = MAX_STRIKE_STEPS;
  const [strikeOff, setStrikeOff] = useState(0);
  useEffect(() => setStrikeOff(0), [asset]);
  const pickSide = (s: Side) => {
    if (s !== side) setStrikeOff((o) => -o); // keep the same distance from the money on the other side
    setSide(s);
  };
  const atmStrike = spot ? Math.round(spot / step) * step : null;
  const strike = atmStrike !== null ? atmStrike + strikeOff * step : null;

  const amt = Math.max(0, parseFloat(amount) || 0);

  const ticket = useMemo(() => {
    if (!spot || strike === null || !account.ready) return null;
    const { perUnit, units, maxPayout: mp } = priceTicket(side, spot, strike, sigma, expiry, now, amt);
    const breakeven = side === "call" ? strike + perUnit : strike - perUnit;
    const chance = probITM(side, spot, strike, sigma, T);
    const multiple = winMultiple(side, spot, strike, sigma, T);
    const here = account.positions.filter((p) => p.status === "open" && p.asset === asset && p.expiry === expiry);
    const spentHere = here.reduce((s, p) => s + p.premium, 0);
    // Pool limits count every open position against the pool (shared in live mode, your own in demo).
    const poolHere = account.openAll.filter((p) => p.asset === asset && p.expiry === expiry && p.side === side);
    const sideLiab = poolHere.reduce((s, p) => s + p.maxPayout, 0);
    const totalLiab = account.openAll.reduce((s, p) => s + p.maxPayout, 0);
    const balance = account.balance;
    const poolBal = account.pool.balance;
    let block: string | null = null;
    if (!account.signedIn) block = "Sign in with X to trade";
    else if (amt < RULES.minPremium) block = `Minimum ${usd(RULES.minPremium, 0)}`;
    else if (amt > RULES.maxPremiumPerPosition) block = `Max ${usd(RULES.maxPremiumPerPosition, 0)} per trade`;
    else if (spentHere + amt > RULES.maxPremiumPerExpiry) block = `Max ${usd(RULES.maxPremiumPerExpiry, 0)} per expiry`;
    else if (balance !== null && amt > balance) block = "Not enough balance";
    else if (sideLiab + mp > RULES.sidePoolShare * poolBal || totalLiab + mp > RULES.totalPoolShare * poolBal) block = "Pool limit reached";
    const room = Math.max(0, Math.min(RULES.maxPremiumPerPosition, RULES.maxPremiumPerExpiry - spentHere, balance ?? RULES.maxPremiumPerPosition));
    return { perUnit, units, breakeven, chance, multiple, mp, block, room };
  }, [spot, strike, account, side, sigma, T, amt, asset, expiry, now]);

  // Strike chips: at the money and four steps out on the chosen side (calls up, puts down), with their multiples.
  const chips = useMemo(() => {
    if (!spot || atmStrike === null) return [];
    return [0, 1, 2, 3, 4].map((k) => {
      const off = side === "call" ? k : -k;
      const k$ = atmStrike + off * step;
      return { off, strike: k$, multiple: winMultiple(side, spot, k$, sigma, T) };
    });
  }, [spot, atmStrike, step, side, sigma, T]);

  async function buy() {
    if (!account.signedIn) return account.signIn?.();
    if (!ticket || ticket.block || strike === null || !spot || buying) return;
    sounds.click();
    setBuying(true);
    const r = await account.buy({ asset, side, strike, tenor, expiry, premium: amt, perUnit: ticket.perUnit, spot, units: ticket.units, maxPayout: ticket.mp });
    setBuying(false);
    if (r.ok) say(`Bought ${asset} ${num(strike)} ${side} · ${usd(amt)}${r.pointsAwarded ? ` · +${r.pointsAwarded} pts` : ""}`);
    else say(r.message, "neg");
  }

  // Derived numbers.
  const positions = account.positions;
  const open = positions.filter((p) => p.status === "open");
  const settled = positions.filter((p) => p.status === "settled");
  const markValue = (p: Position) => {
    const s = market.price[p.asset];
    if (!s) return null;
    return liveMultiple(p, s, sigmaFor(p.asset), now) * p.premium;
  };
  const inOptions = open.reduce((s, p) => s + p.premium, 0);
  const openValue = open.reduce((s, p) => s + (markValue(p) ?? 0), 0);
  const openPnl = openValue - inOptions;
  const realizedPnl = settled.reduce((s, p) => s + (p.payout ?? 0) - p.premium, 0);
  const assetOpen = open.filter((p) => p.asset === asset);
  // Live: global numbers for the asset. Demo: your own positions, as before.
  const callOi = live ? (account.stats?.[asset].callOi ?? 0) : assetOpen.filter((p) => p.side === "call").reduce((s, p) => s + p.premium, 0);
  const putOi = live ? (account.stats?.[asset].putOi ?? 0) : assetOpen.filter((p) => p.side === "put").reduce((s, p) => s + p.premium, 0);
  const vol24 = live
    ? (account.stats?.[asset].vol24 ?? 0)
    : positions.filter((p) => p.asset === asset && now - p.boughtAt < DAY_MS).reduce((s, p) => s + p.premium, 0);
  const change = (a: Asset) => (market.price[a] && market.open24[a] ? market.price[a]! / market.open24[a]! - 1 : null);
  const canTopUp = account.canTopUp;
  const premiumsIn = account.pool.premiumsIn;
  const paidOut = account.pool.paidOut;
  const wins = settled.filter((p) => (p.payout ?? 0) > p.premium).length;
  const tape: TapeItem[] = account.tape;
  const liveFeed = market.venues[asset] >= 2;
  const progress = roundProgress(tenor, expiry, now);

  // Round results (open -> settled, grouped per round): settlement price flash on the chart, toasts.
  const [settled$, setSettled$] = useState<{ asset: Asset; tenor: Tenor; expiry: number; price: number; until: number } | null>(null);
  const [win, setWin] = useState<RoundResult | null>(null);
  const sound = useSound();
  useRoundResults(account.positions, (r: RoundResult) => {
    setSettled$({ asset: r.asset, tenor: r.tenor, expiry: r.expiry, price: r.settle, until: Date.now() + 2_000 });
    // Profitable rounds get the win card; losses keep the small red toast.
    if (r.pnl > 0) sounds.win();
    else sounds.loss();
    if (r.pnl > 0) setWin(r);
    else if (r.positions.length === 1) settledToast(r.positions[0], r.settle, r.payout, say);
    else say(`${r.asset} ${TENORS[r.tenor].label} round settled at ${num(r.settle, r.asset === "BTC" ? 0 : 2)} · ${signed(r.pnl, (x) => usd(x))}`, r.pnl >= 0 ? "pos" : "neg");
  });

  // A quiet tick each second in the last 5 seconds of any round I hold.
  const lastTick = useRef(0);
  useEffect(() => {
    const id = setInterval(() => {
      const t = Date.now();
      const sec = Math.floor(t / 1000);
      if (sec === lastTick.current) return;
      if (account.positions.some((p) => p.status === "open" && p.expiry - t > 0 && p.expiry - t <= 5_000)) {
        lastTick.current = sec;
        sounds.tick();
      }
    }, 100);
    return () => clearInterval(id);
  }, [account.positions]);

  // Closing round: while I hold positions in this asset/tenor whose sales have closed, the chart keeps showing
  // that round (and for the 2s settlement flash after it settles); the round on sale is drawn faintly.
  const closing = open.filter((p) => p.asset === asset && p.tenor === tenor && p.expiry < expiry);
  const justSettled = settled$ && settled$.asset === asset && settled$.tenor === tenor && now < settled$.until ? settled$ : null;
  const focusExpiry = closing.length ? Math.min(...closing.map((p) => p.expiry)) : (justSettled?.expiry ?? null);
  const chartExpiry = focusExpiry ?? expiry;
  const settlesIn = closing.length && focusExpiry !== null ? focusExpiry - now : null;
  const urgent = settlesIn !== null && settlesIn > 0 && settlesIn <= 10_000;
  const chartPositions = open
    .filter((p) => p.asset === asset && p.expiry === chartExpiry)
    .map((p) => ({
      id: p.id,
      side: p.side,
      strike: p.strike,
      label: spot ? `${p.side === "call" ? "C" : "P"} ${num(p.strike, asset === "BTC" ? 0 : 1)} · ${mult(liveMultiple(p, spot, sigma, now))} now` : undefined,
    }));

  function resetAccount() {
    if (resetArmed) {
      account.reset?.();
      setResetArmed(false);
      setMenu(null);
    } else {
      setResetArmed(true);
      setTimeout(() => setResetArmed(false), 4000);
    }
  }

  const optLabel = (p: Position) => (
    <>
      <Coin asset={p.asset} small /> {num(p.strike, p.asset === "BTC" ? 0 : 1)} <span className={p.side}>{p.side === "call" ? "Call" : "Put"}</span>{" "}
      <span className="muted">{TENORS[p.tenor].label}</span>
    </>
  );

  const positionsTable = (
    <table className="tbl">
      <thead>
        <tr>
          <th scope="col">Option</th>
          <th scope="col">Expires in</th>
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
              <td>{optLabel(p)}</td>
              <td>{p.expiry > now ? formatCountdown(p.expiry - now) : "Settling…"}</td>
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

  const historyTable = (
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
              <td>{optLabel(p)}</td>
              <td>{formatClock(p.expiry)}</td>
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

  const board = account.leaderboard;
  const leaderboard = !live ? (
    <div className="empty">
      <p>The leaderboard goes live with accounts.</p>
      <p className="muted">
        You: {settled.length} settled · {settled.length ? pct(wins / settled.length, 0) : "—"} win rate · {signed(realizedPnl, (x) => usd(x))}
      </p>
    </div>
  ) : !board ? (
    <p className="empty">Loading…</p>
  ) : !board.length ? (
    <div className="empty">
      <p>No settled trades this week yet.</p>
      <p className="muted">Ranked by realized P/L · resets Monday 00:00 UTC</p>
    </div>
  ) : (
    <table className="tbl lb">
      <thead>
        <tr>
          <th scope="col">#</th>
          <th scope="col">Trader</th>
          <th scope="col">P/L</th>
          <th scope="col">Trades</th>
          <th scope="col">Win rate</th>
          <th scope="col">Best</th>
          <th scope="col">Points</th>
        </tr>
      </thead>
      <tbody>
        {board.map((r, i) => (
          <tr key={r.userId} className={`${r.isMe ? "me" : ""} ${i > 0 && r.rank > 50 && board[i - 1].rank <= 50 ? "gap" : ""}`}>
            <td>{r.rank}</td>
            <td>
              <Who trader={{ id: r.userId, handle: r.handle, avatar: r.avatar }} />
            </td>
            <td className={r.pnl >= 0 ? "pos" : "neg"}>{signed(r.pnl, (x) => usd(x))}</td>
            <td>{num(r.trades)}</td>
            <td>{pct(r.winRate, 0)}</td>
            <td>{r.bestMultiple.toFixed(1)}×</td>
            <td>{num(r.points)}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );

  const statusList = (
    <dl className="status">
      <div>
        <dt>Price feed</dt>
        <dd>
          BTC {market.venues.BTC}/4 · ETH {market.venues.ETH}/4 venues (Coinbase, Binance, OKX, Hyperliquid)
        </dd>
      </div>
      <div>
        <dt>Pricing vol · {asset}</dt>
        <dd>
          {pct(sigma, 0)} — max of DVOL {impliedFor(asset) ? pct(impliedFor(asset)!, 0) : "n/a"}, 1.25 × realized {pct(realizedFor(asset), 0)}, 35%
        </dd>
      </div>
      <div>
        <dt>House edge</dt>
        <dd>{pct(RULES.baseEdge, 0)} over Black-Scholes fair value</dd>
      </div>
      <div>
        <dt>Settlement</dt>
        <dd>Average of the median price over the final {TENORS[tenor].window / 1000}s ({tenor} rounds)</dd>
      </div>
      <div>
        <dt>Limits</dt>
        <dd>
          {usd(RULES.maxPremiumPerPosition, 0)} per trade · {usd(RULES.maxPremiumPerExpiry, 0)} per expiry · {RULES.payoutCap}× payout cap
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
              More <Chevron dir={menu === "more" ? "up" : "down"} />
            </button>
            {menu === "more" && (
              <div className="menu">
                <button onClick={() => { setBottom("status"); setView("trade"); setMenu(null); }}>Pricing &amp; status</button>
                <button onClick={() => { setView("house"); setMenu(null); }}>How the pool works</button>
                {!live && <button onClick={resetAccount}>{resetArmed ? "Click again to reset" : "Reset paper account"}</button>}
                {live && account.signedIn && <button onClick={() => { setMenu(null); account.signOut?.(); }}>Sign out</button>}
              </div>
            )}
          </div>
        </div>
        <div className="nav-right">
          <button className="mute" onClick={sound.toggle} aria-label={sound.muted ? "Turn sounds on" : "Mute sounds"} aria-pressed={sound.muted} title={sound.muted ? "Sounds off" : "Sounds on"}>
            <Speaker muted={sound.muted} />
          </button>
          <span className="badge">Paper</span>
          {live && account.ready && !account.signedIn ? (
            <button className="signin" onClick={() => account.signIn?.()}>
              Sign in with X
            </button>
          ) : (
            <>
              <span className="navstat">
                <span className="muted">Balance</span> {account.balance !== null ? usd(account.balance) : "—"}
              </span>
              <span className="navstat">
                <span className="muted">Points</span> {account.points !== null ? num(account.points) : "—"}
              </span>
              {canTopUp && (
                <button className="tab" onClick={() => account.topUp()}>
                  Top up
                </button>
              )}
              {live && account.me && <Who trader={account.me} size={22} />}
            </>
          )}
        </div>
      </nav>

      {view === "trade" && (
        <div className="trade">
          <section className="main">
            <div className="bar">
              <div className="dd" data-menu>
                <button className="pill asset" onClick={() => setMenu(menu === "asset" ? null : "asset")} aria-expanded={menu === "asset"}>
                  <Coin asset={asset} />
                  <strong>{asset}</strong>
                  <span className="sep" aria-hidden="true" />
                  <span className="px">{spot ? usd(spot, 2) : "—"}</span>
                  <span className={`chg ${change(asset) !== null && change(asset)! < 0 ? "neg" : "pos"}`}>
                    {change(asset) !== null ? signed(change(asset)!, (x) => pct(x, 2)) : ""}
                  </span>
                  <Chevron dir={menu === "asset" ? "up" : "down"} />
                </button>
                {menu === "asset" && (
                  <div className="menu wide">
                    {ASSETS.map((a) => (
                      <button key={a} className={a === asset ? "on" : ""} onClick={() => { setAsset(a); setMenu(null); setFollow(true); }}>
                        <Coin asset={a} small />
                        <strong>{a}</strong>
                        <span className="grow" />
                        <span>{market.price[a] ? usd(market.price[a]!, 2) : "—"}</span>
                        <span className={`chg ${change(a) !== null && change(a)! < 0 ? "neg" : "pos"}`}>
                          {change(a) !== null ? signed(change(a)!, (x) => pct(x, 2)) : ""}
                        </span>
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
                {follow ? (
                  <span className={`stat live ${liveFeed ? "" : "off"}`}>{liveFeed ? "LIVE" : "CONNECTING"}</span>
                ) : (
                  <button className="stat reset" onClick={() => setFollow(true)}>
                    RESET
                  </button>
                )}
              </div>
            </div>
            <div className="chartbox">
              <Chart
                asset={asset}
                samples={market.samples}
                history={market.history}
                spot={spot}
                sigma={sigma}
                expiry={chartExpiry}
                nextExpiry={focusExpiry !== null ? expiry : null}
                urgent={urgent}
                flash={justSettled ? { price: justSettled.price, until: justSettled.until } : null}
                settleWindow={TENORS[tenor].window}
                side={side}
                strike={strike}
                positions={chartPositions}
                decimals={dec}
                defaultSpan={DEFAULT_SPAN[tenor]}
                follow={follow}
                onFollowChange={setFollow}
              />
              {win && <WinCard result={win} onClose={() => setWin(null)} />}
            </div>
          </section>

          <aside className="side" aria-label="Trade">
            <div className="box">
              <button className="eq-head" onClick={() => setEquityOpen(!equityOpen)} aria-expanded={equityOpen}>
                <Chevron dir={equityOpen ? "up" : "down"} /> Account equity
                <span className="grow" />
                <span>{account.balance !== null ? usd(account.balance + openValue) : "—"}</span>
              </button>
              {equityOpen && (
                <dl className="kv">
                  <div>
                    <dt>Available to trade</dt>
                    <dd>{account.balance !== null ? usd(account.balance) : "—"}</dd>
                  </div>
                  <div>
                    <dt>In options</dt>
                    <dd>{usd(inOptions)}</dd>
                  </div>
                  <div>
                    <dt>Open P/L</dt>
                    <dd className={open.length ? (openPnl >= 0 ? "pos" : "neg") : ""}>{open.length ? signed(openPnl, (x) => usd(x)) : "—"}</dd>
                  </div>
                </dl>
              )}
            </div>

            <div className="toggle" role="group" aria-label="Direction">
              <button className={side === "call" ? "on call" : ""} onClick={() => pickSide("call")} aria-pressed={side === "call"}>
                ↗ Call
              </button>
              <button className={side === "put" ? "on put" : ""} onClick={() => pickSide("put")} aria-pressed={side === "put"}>
                ↘ Put
              </button>
            </div>

            <div className="field">
              <div className="field-row">
                <span className="lbl">Expiry</span>
                <span className="mono">
                  {formatClock(expiry, tenor !== "1h")} · <strong>{formatCountdown(expiry - now)}</strong>
                </span>
              </div>
              <div className="seg" role="group" aria-label="Expiry">
                {TENOR_LIST.map((t) => (
                  <button key={t} className={t === tenor ? "on" : ""} onClick={() => { setTenor(t); setFollow(true); }} aria-pressed={t === tenor}>
                    {TENORS[t].label}
                  </button>
                ))}
              </div>
              {urgent && settlesIn !== null && (
                <div className="settles" role="status">
                  Your round settles in <strong className="mono">{formatCountdown(settlesIn)}</strong>
                </div>
              )}
              <div className={`progress ${urgent ? "urgent" : ""}`} aria-hidden="true">
                <span style={{ width: `${progress * 100}%` }} />
              </div>
            </div>

            <div className="field">
              <div className="field-row">
                <span className="lbl">Strike</span>
                <span className="muted small">{strikeOff === 0 ? "At the money" : spot && strike ? `${signed(strike / spot - 1, (x) => pct(x, 2))} from price` : ""}</span>
              </div>
              <div className="stepper">
                <button aria-label="Lower strike" disabled={strikeOff <= -MAX_OFF} onClick={() => setStrikeOff(strikeOff - 1)}>
                  <Chevron dir="left" />
                </button>
                <span className="strike-val">
                  <strong className="mult">{ticket ? mult(ticket.multiple) : "—"}</strong>
                  <span className="sub">
                    {strike !== null ? num(strike, asset === "BTC" ? 0 : 1) : "—"}
                    {ticket ? ` · ${pct(ticket.chance, 0)} chance` : ""}
                  </span>
                </span>
                <button aria-label="Higher strike" disabled={strikeOff >= MAX_OFF} onClick={() => setStrikeOff(strikeOff + 1)}>
                  <Chevron dir="right" />
                </button>
              </div>
              <div className="ladder" role="group" aria-label="Strikes by payout multiple">
                {chips.map((c) => (
                  <button
                    key={c.off}
                    className={`${c.off === strikeOff ? "on" : ""} ${side}`}
                    onClick={() => setStrikeOff(c.off)}
                    aria-pressed={c.off === strikeOff}
                    aria-label={`Strike ${num(c.strike, asset === "BTC" ? 0 : 1)}, win about ${mult(c.multiple)}`}
                    title={num(c.strike, asset === "BTC" ? 0 : 1)}
                  >
                    {mult(c.multiple)}
                  </button>
                ))}
              </div>
            </div>

            <div className="field">
              <div className="field-row">
                <span className="lbl">Premium (USDC)</span>
              </div>
              <div className="amount">
                <button onClick={() => setAmount(String(Math.max(1, Math.round(amt / 2))))}>½×</button>
                <button onClick={() => setAmount(String(Math.min(RULES.maxPremiumPerPosition, Math.round(amt * 2) || 1)))}>2×</button>
                <button onClick={() => ticket && setAmount(String(Math.floor(ticket.room)))}>Max</button>
                <input inputMode="decimal" aria-label="Premium in USDC" value={amount} onChange={(e) => setAmount(e.target.value.replace(/[^0-9.]/g, ""))} />
              </div>
            </div>

            <dl className="kv summary">
              <div>
                <dt>If it wins</dt>
                <dd>{ticket ? `≈ ${usd(amt * ticket.multiple)}` : "—"}</dd>
              </div>
              <div>
                <dt>Breakeven</dt>
                <dd>{ticket ? num(ticket.breakeven, asset === "BTC" ? 0 : 1) : "—"}</dd>
              </div>
              <div>
                <dt>Max payout</dt>
                <dd>{usd(RULES.payoutCap * amt, 0)}</dd>
              </div>
            </dl>

            <button className={`buy ${side}`} onClick={buy} disabled={!ticket || buying || (!!ticket.block && account.signedIn)}>
              {!ticket ? "Waiting for price…" : buying ? "Buying…" : ticket.block ?? `Buy ${side === "call" ? "Call" : "Put"} · win ≈ ${mult(ticket.multiple)}`}
            </button>

            <div className="grow" />
            <div className="box open-box">
              <span>
                Open positions <span className="muted">{open.length || "—"}</span>
              </span>
              <span className={open.length ? (openPnl >= 0 ? "pos" : "neg") : "muted"}>{open.length ? signed(openPnl, (x) => usd(x)) : ""}</span>
            </div>
          </aside>

          <section className="bottom">
            <div className="btabs">
              {(["positions", "history", "leaderboard", "status"] as BottomTab[]).map((b) => (
                <button key={b} className={`btab ${bottom === b ? "on" : ""}`} onClick={() => setBottom(b)}>
                  {b[0].toUpperCase() + b.slice(1)}
                  {b === "positions" && open.length > 0 && <span className="count">{open.length}</span>}
                </button>
              ))}
              <div className={`tape ${tape.length ? "" : "empty-tape"}`} aria-label="Recent trades">
                {tape.length > 0 && (
                  <div className="tape-track">
                    {[...tape, ...tape].map((p, i) => {
                      const pnl = (p.payout ?? 0) - p.premium;
                      const paid = p.payout ?? 0;
                      return (
                        <span key={`${p.id}-${i}`} className="chip" aria-hidden={i >= tape.length}>
                          {live && <Who trader={p.trader} />}
                          <Coin asset={p.asset} small />
                          {live && p.status === "settled" ? (
                            paid > p.premium ? (
                              <span className="pos">
                                +{compact(paid)} · {(paid / p.premium).toFixed(1)}×
                              </span>
                            ) : (
                              <span className="neg">{signed(pnl, compact)}</span>
                            )
                          ) : p.status === "open" ? (
                            <span className={p.side}>
                              {p.side === "call" ? "▲" : "▼"} {compact(p.premium)}
                            </span>
                          ) : (
                            <span className={pnl >= 0 ? "pos" : "neg"}>{signed(pnl, compact)}</span>
                          )}
                        </span>
                      );
                    })}
                  </div>
                )}
              </div>
            </div>
            <div className="bbody">
              {bottom === "positions" && (open.length ? positionsTable : <p className="empty">No open positions.</p>)}
              {bottom === "history" && (settled.length ? historyTable : <p className="empty">No settled trades yet.</p>)}
              {bottom === "leaderboard" && leaderboard}
              {bottom === "status" && statusList}
            </div>
          </section>
          {toast && (
            <div className={`toast ${toast.tone}`} role="status">
              {toast.text}
            </div>
          )}
        </div>
      )}

      {view === "portfolio" && (
        <main className="page">
          <h1>Portfolio</h1>
          <div className="cards">
            <div className="card">
              <span className="lbl">Equity</span>
              <strong>{account.balance !== null ? usd(account.balance + openValue) : "—"}</strong>
            </div>
            <div className="card">
              <span className="lbl">Realized P/L</span>
              <strong className={realizedPnl >= 0 ? "pos" : "neg"}>{signed(realizedPnl, (x) => usd(x))}</strong>
            </div>
            <div className="card">
              <span className="lbl">Win rate</span>
              <strong>{settled.length ? pct(wins / settled.length, 0) : "—"}</strong>
            </div>
            <div className="card">
              <span className="lbl">Points</span>
              <strong>{num(account.points ?? 0)}</strong>
            </div>
          </div>
          <h2>Open</h2>
          {open.length ? positionsTable : <p className="empty left">No open positions.</p>}
          <h2>History</h2>
          {settled.length ? historyTable : <p className="empty left">No settled trades yet.</p>}
        </main>
      )}

      {view === "house" && (
        <main className="page">
          <h1>House pool</h1>
          <p className="lead">
            Every premium goes into its round&apos;s escrow. At expiry, winners are paid from that escrow first, then from the pool; anything left over
            goes to the pool. {live ? "Everyone trades against this one shared pool" : "In paper mode the pool is simulated"}, which started at {usd(START_POOL, 0)}.
          </p>
          <div className="cards">
            <div className="card">
              <span className="lbl">Pool balance</span>
              <strong>{usd(account.pool.balance, 0)}</strong>
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
              <strong className={account.pool.balance - START_POOL >= 0 ? "pos" : "neg"}>{signed(account.pool.balance - START_POOL, (x) => usd(x, 0))}</strong>
            </div>
          </div>
          <h2>Rules</h2>
          {statusList}
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

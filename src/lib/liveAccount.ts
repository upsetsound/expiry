"use client";
// Supabase-backed account: X sign-in, the shared pool, everyone's trades over Realtime, server-side buys/settlement.
import { useCallback, useEffect, useRef, useState } from "react";
import type { RealtimePostgresChangesPayload } from "@supabase/supabase-js";
import { type AccountApi, type AssetStats, type LeaderRow, type Notify, type PoolState, type Prizes, type ServerVol, type TapeItem, type Trader } from "./account";
import type { Asset } from "./feeds";
import { supabaseBrowser } from "./supabase/client";
import { DEFAULT_LIMITS, type Limits } from "./pricing";
import { START_POOL, TOP_UP_BELOW, WEEK_MS, type Position } from "./store";

type Row = {
  id: string;
  user_id: string;
  asset: Asset;
  side: "call" | "put";
  strike: number;
  tenor: Position["tenor"];
  expiry: string;
  premium: number | string;
  units: number;
  max_payout: number | string;
  payout_cap: number | string;
  spot_at_buy: number;
  status: "open" | "settled" | "closed";
  settle_price: number | null;
  payout: number | string | null;
  created_at: string;
  settled_at: string | null;
  close_price: number | null;
  close_proceeds: number | string | null;
  closed_at: string | null;
};
type Me = { id: string; x_handle: string | null; avatar_url: string | null; balance: number; points: number; last_top_up: string };

const COLS = "id,user_id,asset,side,strike,tenor,expiry,premium,units,max_payout,payout_cap,spot_at_buy,status,settle_price,payout,created_at,settled_at,close_price,close_proceeds,closed_at";
const TAPE_LEN = 30;

const toPosition = (r: Row): Position & { userId: string; eventAt: number } => ({
  id: r.id,
  userId: r.user_id,
  asset: r.asset,
  side: r.side,
  strike: Number(r.strike),
  tenor: r.tenor,
  expiry: Date.parse(r.expiry),
  premium: Number(r.premium),
  units: Number(r.units),
  maxPayout: Number(r.max_payout),
  payoutCap: Number(r.payout_cap ?? 20),
  boughtAt: Date.parse(r.created_at),
  spotAtBuy: Number(r.spot_at_buy),
  status: r.status,
  settle: r.settle_price ?? undefined,
  payout: r.payout === null ? undefined : Number(r.payout),
  closePrice: r.close_price ?? undefined,
  closeProceeds: r.close_proceeds === null || r.close_proceeds === undefined ? undefined : Number(r.close_proceeds),
  closedAt: r.closed_at ? Date.parse(r.closed_at) : undefined,
  eventAt: Date.parse(r.settled_at ?? r.closed_at ?? r.created_at),
});
type LivePos = ReturnType<typeof toPosition>;

const upsert = (list: LivePos[], p: LivePos) => {
  const i = list.findIndex((x) => x.id === p.id);
  return i === -1 ? [p, ...list] : list.map((x, j) => (j === i ? p : x));
};

export function useLiveAccount(notify: Notify): AccountApi {
  const sb = supabaseBrowser();
  const [userId, setUserId] = useState<string | null | undefined>(undefined); // undefined = checking
  const [me, setMe] = useState<Me | null>(null);
  const [mine, setMine] = useState<LivePos[]>([]);
  const [open, setOpen] = useState<LivePos[]>([]);
  const [recent, setRecent] = useState<LivePos[]>([]);
  const [traders, setTraders] = useState<Record<string, Trader>>({});
  const [pool, setPool] = useState<PoolState>({ balance: START_POOL, premiumsIn: 0, paidOut: 0 });
  const [stats, setStats] = useState<Record<Asset, AssetStats> | null>(null);
  const [board, setBoard] = useState<LeaderRow[] | null>(null);
  const [vol, setVol] = useState<Record<Asset, ServerVol> | null>(null);
  const [prizes, setPrizes] = useState<Prizes | null>(null);
  const [limits, setLimits] = useState<Limits>(DEFAULT_LIMITS);
  const userRef = useRef<string | null>(null);
  const notifyRef = useRef(notify);
  notifyRef.current = notify;

  // Session.
  useEffect(() => {
    sb.auth.getUser().then(({ data }) => setUserId(data.user?.id ?? null));
    const { data } = sb.auth.onAuthStateChange((_e, session) => setUserId(session?.user.id ?? null));
    const err = new URLSearchParams(window.location.search).get("auth_error");
    if (err) {
      notifyRef.current(`Sign-in failed: ${err}`, "neg");
      window.history.replaceState(null, "", window.location.pathname);
    }
    return () => data.subscription.unsubscribe();
  }, [sb]);
  useEffect(() => {
    userRef.current = userId ?? null;
  }, [userId]);

  const loadMe = useCallback(async () => {
    if (!userRef.current) return setMe(null);
    const { data } = await sb.rpc("my_account").maybeSingle<Me>();
    if (data) setMe({ ...data, balance: Number(data.balance) });
  }, [sb]);

  const loadTraders = useCallback(
    async (ids: string[]) => {
      const missing = Array.from(new Set(ids)).filter((id) => !(id in traders));
      if (!missing.length) return;
      const { data } = await sb.from("profiles").select("id,x_handle,avatar_url").in("id", missing);
      if (data)
        setTraders((t) => {
          const next = { ...t };
          for (const p of data) next[p.id] = { id: p.id, handle: p.x_handle, avatar: p.avatar_url };
          return next;
        });
    },
    [sb, traders],
  );

  const loadStats = useCallback(async () => {
    const [b, e] = await Promise.all([sb.rpc("asset_stats", { p_asset: "BTC" }).single<AssetStats & { call_oi: number; put_oi: number }>(), sb.rpc("asset_stats", { p_asset: "ETH" }).single<AssetStats & { call_oi: number; put_oi: number }>()]);
    const f = (d: { vol24: number; call_oi: number; put_oi: number } | null): AssetStats => ({ vol24: Number(d?.vol24 ?? 0), callOi: Number(d?.call_oi ?? 0), putOi: Number(d?.put_oi ?? 0) });
    setStats({ BTC: f(b.data), ETH: f(e.data) });
  }, [sb]);

  const loadPrizes = useCallback(async () => {
    const { data } = await sb.from("settings").select("*").maybeSingle();
    if (!data) return;
    setPrizes({ enabled: !!data.prizes_enabled, amounts: (data.prize_amounts ?? []).map(Number), minTrades: Number(data.prize_min_trades) });
    if (data.max_premium_per_trade)
      setLimits({ maxPerTrade: Number(data.max_premium_per_trade), maxPerRound: Number(data.max_premium_per_round), payoutCap: Number(data.payout_cap) });
  }, [sb]);

  const loadBoard = useCallback(async () => {
    const { data } = await sb.rpc("leaderboard");
    if (!data) return;
    setBoard(
      (data as Record<string, unknown>[]).map((r) => ({
        rank: Number(r.rank),
        userId: String(r.user_id),
        handle: (r.x_handle as string) ?? null,
        avatar: (r.avatar_url as string) ?? null,
        pnl: Number(r.pnl),
        trades: Number(r.trades),
        winRate: Number(r.win_rate),
        bestMultiple: Number(r.best_multiple),
        points: Number(r.points),
        isMe: !!r.is_me,
        eligible: r.eligible === undefined ? true : !!r.eligible,
        prize: r.prize === null || r.prize === undefined ? null : Number(r.prize),
      })),
    );
  }, [sb]);

  // Shared data: open interest, the recent tape, the pool, stats, leaderboard. Works signed out too.
  useEffect(() => {
    (async () => {
      const [o, r, p] = await Promise.all([
        sb.from("positions").select(COLS).eq("status", "open").order("created_at", { ascending: false }).limit(2000),
        sb.from("positions").select(COLS).order("created_at", { ascending: false }).limit(TAPE_LEN),
        sb.from("pool").select("balance,premiums_in,paid_out").single(),
      ]);
      if (o.data) setOpen((o.data as Row[]).map(toPosition));
      if (r.data) setRecent((r.data as Row[]).map(toPosition));
      if (p.data) setPool({ balance: Number(p.data.balance), premiumsIn: Number(p.data.premiums_in), paidOut: Number(p.data.paid_out) });
    })();
    loadStats();
    loadBoard();
    loadPrizes();
    const id = setInterval(() => {
      loadStats();
      loadBoard();
      loadPrizes();
    }, 30_000);
    return () => clearInterval(id);
  }, [sb, loadStats, loadBoard, loadPrizes]);

  // My account and positions.
  useEffect(() => {
    if (!userId) {
      setMe(null);
      setMine([]);
      return;
    }
    loadMe();
    loadBoard();
    sb.from("positions")
      .select(COLS)
      .eq("user_id", userId)
      .order("created_at", { ascending: false })
      .limit(300)
      .then(({ data }) => data && setMine((data as Row[]).map(toPosition)));
  }, [sb, userId, loadMe, loadBoard]);

  // Realtime: everyone's buys and settlements, and the pool.
  const statsTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => {
    const onPosition = (payload: RealtimePostgresChangesPayload<Row>) => {
      const row = payload.new as Row;
      if (!row?.id) return;
      const p = toPosition(row);
      setRecent((list) => upsert(list, p).sort((a, b) => b.eventAt - a.eventAt).slice(0, TAPE_LEN));
      setOpen((list) => (p.status === "open" ? upsert(list, p) : list.filter((x) => x.id !== p.id)));
      if (p.userId === userRef.current) {
        setMine((list) => upsert(list, p));
        if (p.status === "settled") {
          loadMe();
          loadBoard();
        }
      }
      if (!statsTimer.current) statsTimer.current = setTimeout(() => ((statsTimer.current = null), loadStats()), 1500);
    };
    const channel = sb
      .channel("expiry-live")
      .on("postgres_changes", { event: "INSERT", schema: "public", table: "positions" }, onPosition)
      .on("postgres_changes", { event: "UPDATE", schema: "public", table: "positions" }, onPosition)
      .on("postgres_changes", { event: "UPDATE", schema: "public", table: "pool" }, (payload) => {
        const n = payload.new as { balance: number; premiums_in: number; paid_out: number };
        setPool({ balance: Number(n.balance), premiumsIn: Number(n.premiums_in), paidOut: Number(n.paid_out) });
      })
      .subscribe();
    return () => {
      sb.removeChannel(channel);
    };
  }, [sb, loadMe, loadBoard, loadStats]);

  // The server's pricing vol (what /api/buy uses), refreshed a little faster than its 30s cache.
  useEffect(() => {
    const load = () =>
      fetch("/api/market", { cache: "no-store" })
        .then((r) => (r.ok ? r.json() : null))
        .then((v) => v?.BTC?.sigma && v?.ETH?.sigma && setVol(v))
        .catch(() => {});
    load();
    const id = setInterval(load, 15_000);
    return () => clearInterval(id);
  }, []);

  // Fetch handles/avatars for anyone on the tape or leaderboard we haven't seen.
  useEffect(() => {
    loadTraders(recent.map((p) => p.userId));
  }, [recent, loadTraders]);

  // When a round ends, ask the server to settle now rather than waiting for the next cron tick.
  const asked = useRef<Map<string, number>>(new Map());
  useEffect(() => {
    const id = setInterval(() => {
      const now = Date.now();
      for (const p of open) {
        if (p.expiry + 2_500 > now) continue;
        const key = `${p.asset}-${p.tenor}-${p.expiry}`;
        const last = asked.current.get(key) ?? 0;
        if (now - last < 10_000) continue;
        asked.current.set(key, now);
        fetch("/api/settle", { method: "POST" }).catch(() => {});
        break; // one request settles every due round
      }
    }, 1_000);
    return () => clearInterval(id);
  }, [open]);

  const signedIn = !!userId;
  const now = Date.now();
  const tape: TapeItem[] = recent.map((p) => ({ ...p, trader: traders[p.userId] }));

  return {
    mode: "live",
    ready: userId !== undefined,
    signedIn,
    me: me ? { id: me.id, handle: me.x_handle, avatar: me.avatar_url } : null,
    balance: me?.balance ?? null,
    points: me?.points ?? null,
    canTopUp: !!me && me.balance < TOP_UP_BELOW && now - Date.parse(me.last_top_up) > WEEK_MS,
    positions: mine,
    openAll: open,
    tape,
    pool,
    stats,
    leaderboard: board,
    vol,
    prizes,
    limits,
    async buy(r) {
      if (!signedIn) return { ok: false, message: "Sign in with X to trade" };
      const res = await fetch("/api/buy", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ asset: r.asset, side: r.side, strike: r.strike, tenor: r.tenor, expiry: r.expiry, premium: r.premium, perUnit: r.perUnit }),
      }).catch(() => null);
      const body = await res?.json().catch(() => null);
      if (!res || !res.ok || !body?.ok) {
        if (res?.status === 401) setUserId(null);
        return { ok: false, message: body?.message ?? "Couldn't reach the server. Try again." };
      }
      const p = toPosition(body.position as Row);
      setMine((list) => upsert(list, p));
      setOpen((list) => upsert(list, p));
      setMe((m) => (m ? { ...m, balance: Number(body.balance), points: Number(body.points) } : m));
      return { ok: true, pointsAwarded: Number(body.points_awarded ?? 0), multiple: Number(body.quote?.multiple) || undefined };
    },
    async close(p, shownBid) {
      const res = await fetch("/api/close", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ positionId: p.id, bid: shownBid }),
      }).catch(() => null);
      const body = await res?.json().catch(() => null);
      if (!res || !res.ok || !body?.ok) return { ok: false, message: body?.message ?? "Couldn't reach the server. Try again.", bid: body?.bid };
      const closed = toPosition(body.position as Row);
      setMine((list) => upsert(list, closed));
      setOpen((list) => list.filter((x) => x.id !== closed.id));
      setMe((m) => (m ? { ...m, balance: Number(body.balance) } : m));
      return { ok: true, proceeds: Number(body.bid), position: closed };
    },
    async topUp() {
      const res = await fetch("/api/topup", { method: "POST" });
      const body = await res.json().catch(() => null);
      if (!res.ok) notifyRef.current(body?.message ?? "Top-up failed", "neg");
      await loadMe();
    },
    signIn() {
      sb.auth.signInWithOAuth({ provider: "x", options: { redirectTo: `${window.location.origin}/auth/callback` } });
    },
    async signOut() {
      await sb.auth.signOut();
      setUserId(null);
    },
  };
}

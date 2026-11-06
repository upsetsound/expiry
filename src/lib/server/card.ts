// Data for the share cards (trade and day), rendered by /api/card/*. Server only (service role for photos).
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import type { CardData } from "@/app/ShareCard";
import { siteUrl } from "@/lib/site";
import { supabaseAdmin } from "@/lib/supabase/server";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export const BUCKET = "card-backgrounds";

export function safeTz(tz: string | null | undefined): string {
  try {
    if (tz) {
      new Intl.DateTimeFormat("en-US", { timeZone: tz });
      return tz;
    }
  } catch {}
  return "UTC";
}
const fmtDate = (ms: number, tz: string) =>
  new Date(ms).toLocaleDateString("en-US", { weekday: "long", month: "short", day: "numeric", year: "numeric", timeZone: tz });
const fmtTime = (ms: number, tz: string) => new Date(ms).toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit", timeZone: tz });
const money = (n: number) => (n >= 0 ? "+" : "−") + Math.abs(n).toLocaleString("en-US", { style: "currency", currency: "USD", minimumFractionDigits: 2, maximumFractionDigits: 2 });
const mult = (m: number) => (m < 9.95 ? m.toFixed(1) : String(Math.round(m))) + "×";
const site = () => siteUrl().replace(/^https?:\/\//, "");

// Minutes east of UTC for a time zone at a moment (for day boundaries in the sharer's zone).
function tzOffsetMin(tz: string, at: number): number {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat("en-US", { timeZone: tz, hourCycle: "h23", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit" })
      .formatToParts(new Date(at))
      .map((p) => [p.type, p.value]),
  );
  const asUtc = Date.UTC(+parts.year, +parts.month - 1, +parts.day, +parts.hour, +parts.minute, +parts.second);
  return Math.round((asUtc - at) / 60_000);
}
export function dayRange(date: string, tz: string): [number, number] | null {
  const m = date.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!m) return null;
  const utcMidnight = Date.UTC(+m[1], +m[2] - 1, +m[3]);
  const start = utcMidnight - tzOffsetMin(tz, utcMidnight) * 60_000;
  const end = utcMidnight + 86_400_000 - tzOffsetMin(tz, utcMidnight + 86_400_000) * 60_000;
  return [start, end];
}

// A background photo URL, only from the owner's own folder (so nobody can put someone else's photo on a card).
export async function photoUrl(ownerId: string, bg: string | null | undefined): Promise<string | null> {
  if (!bg || !UUID.test(bg)) return null;
  const { data } = await supabaseAdmin().storage.from(BUCKET).createSignedUrl(`${ownerId}/${bg}.jpg`, 600);
  return data?.signedUrl ?? null;
}

let fonts: { name: string; data: Buffer; weight: 500 | 600 | 700; style: "normal" }[] | null = null;
export async function cardFonts() {
  if (fonts) return fonts;
  const load = (f: string) => readFile(join(process.cwd(), "public", "fonts", f));
  const [m, s, b] = await Promise.all([load("InterDisplay-Medium.ttf"), load("InterDisplay-SemiBold.ttf"), load("InterDisplay-Bold.ttf")]);
  fonts = [
    { name: "Inter Display", data: m, weight: 500, style: "normal" },
    { name: "Inter Display", data: s, weight: 600, style: "normal" },
    { name: "Inter Display", data: b, weight: 700, style: "normal" },
  ];
  return fonts;
}

type Row = {
  id: string;
  user_id: string;
  asset: "BTC" | "ETH";
  side: "call" | "put";
  strike: number;
  tenor: string;
  premium: string | number;
  status: string;
  payout: string | number | null;
  close_proceeds: string | number | null;
  settled_at: string | null;
  closed_at: string | null;
  balance_before: string | number | null;
  created_at: string;
};

async function profile(userId: string) {
  const { data } = await supabaseAdmin().from("profiles").select("x_handle,username,avatar_url").eq("id", userId).maybeSingle();
  return { handle: ((data?.x_handle ?? data?.username) as string) ?? null, isX: !!data?.x_handle, avatar: (data?.avatar_url as string) ?? null };
}

// One settled or closed position. Null for unknown ids and open positions.
export async function tradeCard(id: string, tz: string, bg?: string | null): Promise<{ card: CardData; ownerId: string } | null> {
  if (!UUID.test(id)) return null;
  const { data: p } = await supabaseAdmin().from("positions").select("*").eq("id", id).maybeSingle<Row>();
  if (!p || (p.status !== "settled" && p.status !== "closed")) return null;
  const premium = Number(p.premium);
  const got = Number(p.payout ?? p.close_proceeds ?? 0);
  const at = Date.parse((p.status === "closed" ? p.closed_at : p.settled_at) ?? p.created_at);
  const strike = Number(p.strike).toLocaleString("en-US", { maximumFractionDigits: p.asset === "BTC" ? 0 : 2 });
  const prof = await profile(p.user_id);
  return {
    ownerId: p.user_id,
    card: {
      date: fmtDate(at, tz),
      subline: `${p.tenor} ${p.asset} ${p.side === "call" ? "Call" : "Put"} · strike ${strike} · ${p.status === "closed" ? "closed" : "settled"} ${fmtTime(at, tz)}`,
      pnl: money(got - premium),
      profit: got - premium >= 0,
      pill: { coin: p.asset === "BTC" ? "₿" : "Ξ", text: mult(premium > 0 ? got / premium : 0) },
      ...prof,
      site: site(),
      photo: await photoUrl(p.user_id, bg),
    },
  };
}

// A trader's day in their time zone: realized P/L, trades, win rate, and P/L as % of the start-of-day balance
// (the balance just before their first buy that day; "—" for days before balances were recorded).
export async function dayCard(handle: string, date: string, tz: string, bg?: string | null): Promise<CardData | null> {
  const range = dayRange(date, tz);
  if (!range) return null;
  const db = supabaseAdmin();
  // An X handle first, then a Google username (case-insensitive; LIKE wildcards escaped so "_" matches only "_").
  const pattern = handle.replace(/[\\%_]/g, (c) => "\\" + c);
  const cols = "id,x_handle,username,avatar_url";
  const who =
    (await db.from("profiles").select(cols).ilike("x_handle", pattern).limit(1).maybeSingle()).data ??
    (await db.from("profiles").select(cols).ilike("username", pattern).limit(1).maybeSingle()).data;
  if (!who) return null;
  const [from, to] = [new Date(range[0]).toISOString(), new Date(range[1]).toISOString()];
  const { data: rows } = await db
    .from("positions")
    .select("*")
    .eq("user_id", who.id)
    .in("status", ["settled", "closed"])
    .or(`and(settled_at.gte.${from},settled_at.lt.${to}),and(closed_at.gte.${from},closed_at.lt.${to})`);
  const done = (rows ?? []) as Row[];
  if (!done.length) return null;
  const pnl = done.reduce((s, p) => s + Number(p.payout ?? p.close_proceeds ?? 0) - Number(p.premium), 0);
  const wins = done.filter((p) => Number(p.payout ?? p.close_proceeds ?? 0) > Number(p.premium)).length;
  const { data: first } = await db
    .from("positions")
    .select("balance_before")
    .eq("user_id", who.id)
    .gte("created_at", from)
    .lt("created_at", to)
    .order("created_at", { ascending: true })
    .limit(1)
    .maybeSingle();
  const start = first?.balance_before === null || first?.balance_before === undefined ? null : Number(first.balance_before);
  return {
    date: fmtDate(range[0] + 12 * 3_600_000, tz),
    subline: `Day P/L · ${done.length} trade${done.length === 1 ? "" : "s"} · ${Math.round((100 * wins) / done.length)}% win rate`,
    pnl: money(pnl),
    profit: pnl >= 0,
    pill: { coin: null, text: start && start > 0 ? `${pnl >= 0 ? "+" : "−"}${Math.abs((100 * pnl) / start).toFixed(1)}%` : "—" },
    handle: ((who.x_handle ?? who.username) as string) ?? null,
    isX: !!who.x_handle,
    avatar: (who.avatar_url as string) ?? null,
    site: site(),
    photo: await photoUrl(who.id as string, bg),
  };
}

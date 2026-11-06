// Stats for the accelerator application. Visible only to ADMIN_USER_ID; everyone else gets a 404.
import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { currentUserId, supabaseAdmin } from "@/lib/supabase/server";

export const dynamic = "force-dynamic";
export const metadata: Metadata = { title: "Admin · Expiry", robots: { index: false, follow: false } };

type Day = { day: string; signups: number; active_traders: number; trades: number; premium_volume: number; wins: number; losses: number; pool_close: number };
type Cohort = { signup_day: string; signups: number; d1_retained: number; d7_retained: number; d1_eligible: boolean; d7_eligible: boolean };
type Totals = { signups: number; traders: number; trades: number; premium_volume: number; wins: number; losses: number; pool_balance: number };

const num = (n: number) => Number(n).toLocaleString("en-US");
const usd = (n: number) => Number(n).toLocaleString("en-US", { style: "currency", currency: "USD", maximumFractionDigits: 0 });
const pct = (a: number, b: number) => (b > 0 ? `${Math.round((100 * a) / b)}%` : "—");
const dayLabel = (d: string) => new Date(`${d.slice(0, 10)}T00:00:00Z`).toLocaleDateString("en-US", { month: "short", day: "numeric", timeZone: "UTC" });

function PoolChart({ days }: { days: Day[] }) {
  const pts = days.map((d) => Number(d.pool_close));
  if (pts.length < 2) return null;
  const W = 720, H = 180, P = 8;
  const lo = Math.min(...pts), hi = Math.max(...pts), span = hi - lo || 1;
  const x = (i: number) => P + (i / (pts.length - 1)) * (W - 2 * P);
  const y = (v: number) => P + (1 - (v - lo) / span) * (H - 2 * P);
  return (
    <figure className="admin-chart">
      <svg viewBox={`0 0 ${W} ${H}`} role="img" aria-label={`House pool from ${usd(pts[0])} to ${usd(pts[pts.length - 1])}`}>
        <polyline fill="none" stroke="var(--mint)" strokeWidth={2} points={pts.map((v, i) => `${x(i)},${y(v)}`).join(" ")} />
      </svg>
      <figcaption className="muted small">
        {dayLabel(days[0].day)}: {usd(pts[0])} → {dayLabel(days[days.length - 1].day)}: {usd(pts[pts.length - 1])} · low {usd(lo)} · high {usd(hi)}
      </figcaption>
    </figure>
  );
}

export default async function Admin() {
  const admin = process.env.ADMIN_USER_ID;
  const me = await currentUserId();
  if (!admin || me !== admin) notFound();

  const db = supabaseAdmin();
  const [t, d, r] = await Promise.all([
    db.from("admin_totals").select("*").single<Totals>(),
    db.from("admin_daily").select("*").order("day", { ascending: true }),
    db.from("admin_retention").select("*").order("signup_day", { ascending: false }),
  ]);
  if (t.error || d.error || r.error) throw new Error(t.error?.message ?? d.error?.message ?? r.error?.message);
  const totals = t.data!;
  const allDays = (d.data ?? []) as Day[];
  const cohorts = (r.data ?? []) as Cohort[];
  // Chart from the first day with any activity (or the last 14 days).
  const first = allDays.findIndex((x) => Number(x.trades) > 0 || Number(x.signups) > 0);
  const chartDays = allDays.slice(Math.min(first === -1 ? allDays.length - 14 : first, allDays.length - 14));
  const last14 = allDays.slice(-14).reverse();
  const d1 = cohorts.filter((c) => c.d1_eligible);
  const d7 = cohorts.filter((c) => c.d7_eligible);
  const sum = (xs: Cohort[], k: keyof Cohort) => xs.reduce((s, c) => s + Number(c[k]), 0);

  return (
    <main className="page admin">
      <h1>Stats</h1>
      <div className="cards">
        {[
          ["Signups", num(totals.signups)],
          ["Traders", num(totals.traders)],
          ["Trades", num(totals.trades)],
          ["Premium volume", usd(totals.premium_volume)],
          ["Wins / losses", `${num(totals.wins)} / ${num(totals.losses)}`],
          ["House pool", usd(totals.pool_balance)],
          ["Day-1 retention", `${pct(sum(d1, "d1_retained"), sum(d1, "signups"))}`],
          ["Day-7 retention", `${pct(sum(d7, "d7_retained"), sum(d7, "signups"))}`],
        ].map(([label, value]) => (
          <div className="card" key={label}>
            <span className="lbl">{label}</span>
            <strong>{value}</strong>
          </div>
        ))}
      </div>
      <p className="muted small">Active = placed a trade that UTC day. Day-N retention = signed up, then traded again exactly N days later (only cohorts old enough count).</p>

      <h2>House pool over time</h2>
      <PoolChart days={chartDays} />

      <h2>Last 14 days</h2>
      <table className="tbl">
        <thead>
          <tr>
            {["Day", "Signups", "Active traders", "Trades", "Premium", "Wins", "Losses", "Pool (close)"].map((h) => (
              <th scope="col" key={h}>
                {h}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {last14.map((x) => (
            <tr key={x.day}>
              <td>{dayLabel(x.day)}</td>
              <td>{num(x.signups)}</td>
              <td>{num(x.active_traders)}</td>
              <td>{num(x.trades)}</td>
              <td>{usd(x.premium_volume)}</td>
              <td>{num(x.wins)}</td>
              <td>{num(x.losses)}</td>
              <td>{usd(x.pool_close)}</td>
            </tr>
          ))}
        </tbody>
      </table>

      <h2>Retention by signup day</h2>
      <table className="tbl">
        <thead>
          <tr>
            {["Signup day", "Signups", "Day 1", "Day 7"].map((h) => (
              <th scope="col" key={h}>
                {h}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {cohorts.map((c) => (
            <tr key={c.signup_day}>
              <td>{dayLabel(c.signup_day)}</td>
              <td>{num(c.signups)}</td>
              <td>{c.d1_eligible ? `${num(c.d1_retained)} (${pct(Number(c.d1_retained), Number(c.signups))})` : "not yet"}</td>
              <td>{c.d7_eligible ? `${num(c.d7_retained)} (${pct(Number(c.d7_retained), Number(c.signups))})` : "not yet"}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </main>
  );
}

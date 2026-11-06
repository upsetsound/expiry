// Weekly prize rules. Reads the live settings row so amounts, the minimum and on/off are always current.
import type { Metadata } from "next";
import Link from "next/link";

export const metadata: Metadata = { title: "Weekly prize rules · Expiry" };
export const revalidate = 60;

type Settings = { prizes_enabled: boolean; prize_amounts: number[]; prize_min_trades: number };

async function loadSettings(): Promise<Settings> {
  const fallback: Settings = { prizes_enabled: false, prize_amounts: [100, 50, 25], prize_min_trades: 20 };
  try {
    const r = await fetch(`${process.env.NEXT_PUBLIC_SUPABASE_URL}/rest/v1/settings?select=prizes_enabled,prize_amounts,prize_min_trades&limit=1`, {
      headers: { apikey: process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ?? "" },
      next: { revalidate: 60 },
    });
    const rows = (await r.json()) as Settings[];
    return rows?.[0] ? { ...rows[0], prize_amounts: rows[0].prize_amounts.map(Number) } : fallback;
  } catch {
    return fallback;
  }
}

const usd = (n: number) => n.toLocaleString("en-US", { style: "currency", currency: "USD", maximumFractionDigits: 0 });
const places = ["1st", "2nd", "3rd", "4th", "5th"];

export default async function Rules() {
  const s = await loadSettings();
  const handle = process.env.NEXT_PUBLIC_X_HANDLE;
  return (
    <main className="page rules">
      <p>
        <Link href="/" className="muted">
          ← Back to trading
        </Link>
      </p>
      <h1>Weekly prize rules</h1>
      <p className="lead">
        {s.prizes_enabled
          ? `This week's prizes: ${s.prize_amounts.map((a, i) => `${places[i] ?? `#${i + 1}`} ${usd(a)}`).join(", ")} in USDC.`
          : "Prizes aren't running yet. The leaderboard is live; these rules apply once prizes are turned on."}
      </p>
      <ol>
        <li>Free to enter. No purchase or payment of any kind is required. All trading uses paper money with no cash value.</li>
        <li>
          Each week runs Monday 00:00 to Sunday 23:59 UTC. The top {s.prize_amounts.length} traders by realized profit and loss on positions settled
          that week win the prizes listed above, paid in USDC.
        </li>
        <li>To be eligible you need at least {s.prize_min_trades} settled trades in the week. Traders below that still appear on the leaderboard, marked &quot;not eligible yet&quot;.</li>
        <li>Ties on profit and loss go to the trader with more trades that week.</li>
        <li>Winners are contacted on X{handle ? ` from @${handle}` : ""} after the week ends. We never ask for passwords, seed phrases or payment.</li>
        <li>You must be 18 or older to win. Void where prohibited or restricted by law. Winners are responsible for any taxes on prizes.</li>
        <li>One account per person. Accounts that use automation, multiple accounts or exploit bugs may be disqualified.</li>
        <li>We may change, pause or cancel the prizes or these rules at any time. The rules shown on this page are the ones in effect.</li>
      </ol>
    </main>
  );
}

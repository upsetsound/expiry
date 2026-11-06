// Text for the win card's "Share on X" post.
import type { RoundResult } from "./useRoundResults";
import type { Tenor } from "./schedule";

const TENOR_WORDS: Record<Tenor, string> = { "1m": "1-minute", "5m": "5-minute", "15m": "15-minute", "1h": "1-hour" };

// Payout multiple: one decimal under 10x ("4.2×"), whole numbers above ("14×").
export const formatMultiple = (m: number) => `${m < 10 ? m.toFixed(1) : Math.round(m)}×`;

// "Just hit 8.4× on a 1-minute BTC call on @handle 📈 <link>" — the handle and link parts are left out when unset.
// The link is the win's /w/<id> page when there is one (it renders as a card on X), else the site.
export function shareText(r: RoundResult, handle = process.env.NEXT_PUBLIC_X_HANDLE ?? "", site = process.env.NEXT_PUBLIC_SITE_URL ?? ""): string {
  const sides = new Set(r.positions.map((p) => p.side));
  const side = sides.size === 1 ? [...sides][0] : "trade";
  const h = handle.trim().replace(/^@/, "");
  // A bare site is shown without the scheme; a /w/ link keeps it so X fetches the card.
  const raw = site.trim().replace(/\/$/, "");
  const s = raw.includes("/w/") ? raw : raw.replace(/^https?:\/\//, "");
  return [`Just hit ${formatMultiple(r.multiple)} on a ${TENOR_WORDS[r.tenor]} ${r.asset} ${side}`, h && `on @${h}`, "📈", s].filter(Boolean).join(" ");
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// The /w/<id> page for the round's best-paying position (live positions only; demo ids aren't shareable).
export function winLink(r: RoundResult, base: string): string | null {
  const best = [...r.positions].sort((a, b) => (b.payout ?? 0) - (a.payout ?? 0))[0];
  return best && UUID.test(best.id) && base ? `${base.replace(/\/$/, "")}/w/${best.id}` : null;
}

export function shareUrl(r: RoundResult, origin = typeof window !== "undefined" ? window.location.origin : ""): string {
  const base = process.env.NEXT_PUBLIC_SITE_URL?.trim() || origin;
  const link = winLink(r, base);
  return `https://x.com/intent/post?text=${encodeURIComponent(link ? shareText(r, undefined, link) : shareText(r))}`;
}

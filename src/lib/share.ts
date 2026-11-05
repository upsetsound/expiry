// Text for the win card's "Share on X" post.
import type { RoundResult } from "./useRoundResults";
import type { Tenor } from "./schedule";

const TENOR_WORDS: Record<Tenor, string> = { "1m": "1-minute", "5m": "5-minute", "15m": "15-minute", "1h": "1-hour" };

// Payout multiple: one decimal under 10x ("4.2×"), whole numbers above ("14×").
export const formatMultiple = (m: number) => `${m < 10 ? m.toFixed(1) : Math.round(m)}×`;

// "Just hit 8.4× on a 1-minute BTC call on @handle 📈 site" — the handle and site parts are left out when unset.
export function shareText(r: RoundResult, handle = process.env.NEXT_PUBLIC_X_HANDLE ?? "", site = process.env.NEXT_PUBLIC_SITE_URL ?? ""): string {
  const sides = new Set(r.positions.map((p) => p.side));
  const side = sides.size === 1 ? [...sides][0] : "trade";
  const h = handle.trim().replace(/^@/, "");
  const s = site.trim().replace(/^https?:\/\//, "").replace(/\/$/, "");
  return [`Just hit ${formatMultiple(r.multiple)} on a ${TENOR_WORDS[r.tenor]} ${r.asset} ${side}`, h && `on @${h}`, "📈", s].filter(Boolean).join(" ");
}

export const shareUrl = (r: RoundResult) => `https://x.com/intent/post?text=${encodeURIComponent(shareText(r))}`;

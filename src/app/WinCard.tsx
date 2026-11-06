"use client";
// Win screen: the share card (scaled) over the chart when one of my rounds settles in profit or I close at 2x+.
// Closes after 4s (paused while hovered) or on click. "Share…" opens the share window (live mode).
import { useEffect, useRef } from "react";
import ShareCard, { CARD_H, CARD_W, type CardData } from "./ShareCard";
import type { RoundResult } from "@/lib/useRoundResults";
import { TENORS } from "@/lib/schedule";
import { formatMultiple, shareText } from "@/lib/share";
import type { ShareTarget } from "./ShareModal";

const SHOW_MS = 4_000;
const SCALE = 0.42;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function cardFor(r: RoundResult, me: { handle: string | null; avatar: string | null } | null): CardData {
  const one = r.positions.length === 1 ? r.positions[0] : null;
  const at = one?.closedAt ?? Date.now();
  const strike = one ? one.strike.toLocaleString("en-US", { maximumFractionDigits: r.asset === "BTC" ? 0 : 2 }) : null;
  const time = new Date(at).toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit" });
  const side = one ? (one.side === "call" ? "Call" : "Put") : "round";
  return {
    date: new Date(at).toLocaleDateString("en-US", { weekday: "long", month: "short", day: "numeric", year: "numeric" }),
    subline: one
      ? `${TENORS[r.tenor].label} ${r.asset} ${side} · strike ${strike} · ${r.closed ? "closed" : "settled"} ${time}`
      : `${TENORS[r.tenor].label} ${r.asset} round · ${r.positions.length} positions · settled ${time}`,
    pnl: (r.pnl >= 0 ? "+" : "−") + Math.abs(r.pnl).toLocaleString("en-US", { style: "currency", currency: "USD" }),
    profit: r.pnl >= 0,
    pill: { coin: r.asset === "BTC" ? "₿" : "Ξ", text: formatMultiple(r.multiple) },
    handle: me?.handle ?? null,
    avatar: me?.avatar ?? null,
    site: (process.env.NEXT_PUBLIC_SITE_URL || window.location.origin).replace(/^https?:\/\//, ""),
    photo: null,
  };
}

export default function WinCard({
  result,
  me,
  onClose,
  onShare,
}: {
  result: RoundResult;
  me: { handle: string | null; avatar: string | null } | null;
  onClose: () => void;
  onShare?: (t: ShareTarget) => void;
}) {
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const start = () => {
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(onClose, SHOW_MS);
  };
  const stop = () => {
    if (timer.current) clearTimeout(timer.current);
  };
  useEffect(() => {
    start();
    return stop;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [result.key]);

  // Share the round's best-paying position (live positions have server ids; demo ones don't).
  const best = [...result.positions].sort((a, b) => (b.payout ?? b.closeProceeds ?? 0) - (a.payout ?? a.closeProceeds ?? 0))[0];
  const canShare = !!onShare && !!best && UUID.test(best.id);

  return (
    <div className="wincard-wrap">
      <div className="wincard card-win" role="dialog" aria-label="You won" onClick={onClose} onMouseEnter={stop} onMouseLeave={start}>
        <div style={{ width: CARD_W * SCALE, height: CARD_H * SCALE, overflow: "hidden", borderRadius: 10 }}>
          <div style={{ transform: `scale(${SCALE})`, transformOrigin: "top left", width: CARD_W, height: CARD_H }}>
            <ShareCard d={cardFor(result, me)} />
          </div>
        </div>
        <div className="win-actions">
          {canShare && (
            <button
              className="win-share"
              onClick={(e) => {
                e.stopPropagation();
                onShare!({ kind: "trade", id: best.id, text: shareText(result, undefined, "") });
                onClose();
              }}
            >
              Share…
            </button>
          )}
          <button
            className="win-again"
            onClick={(e) => {
              e.stopPropagation();
              onClose();
            }}
          >
            Trade again
          </button>
        </div>
      </div>
    </div>
  );
}

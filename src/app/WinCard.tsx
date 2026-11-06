"use client";
// Win screen: a card over the chart when one of my rounds settles in profit. Closes after 4s (paused while the
// pointer is over it) or on click. Share on X opens a prefilled post.
import { useEffect, useRef } from "react";
import type { RoundResult } from "@/lib/useRoundResults";
import { TENORS, formatClock } from "@/lib/schedule";
import { formatMultiple, shareUrl } from "@/lib/share";

const SHOW_MS = 4_000;

const usd = (n: number) => n.toLocaleString(undefined, { style: "currency", currency: "USD", minimumFractionDigits: 2, maximumFractionDigits: 2 });

export default function WinCard({ result, onClose }: { result: RoundResult; onClose: () => void }) {
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

  const dec = result.asset === "BTC" ? 0 : 2;
  const one = result.positions.length === 1 ? result.positions[0] : null;
  const option = one
    ? `${result.asset} ${one.strike.toLocaleString(undefined, { maximumFractionDigits: 1 })} ${one.side === "call" ? "Call" : "Put"} · ${TENORS[result.tenor].label}`
    : `${result.asset} ${TENORS[result.tenor].label} round · ${result.positions.length} positions`;
  const share = (e: React.MouseEvent) => {
    e.stopPropagation();
    window.open(shareUrl(result), "_blank", "noopener,noreferrer");
    onClose();
  };

  return (
    <div className="wincard-wrap">
      <div className="wincard" role="dialog" aria-label="You won" onClick={onClose} onMouseEnter={stop} onMouseLeave={start}>
        <div className="win-pnl">{result.closed ? "Closed " : ""}+{usd(result.payout)}</div>
        <div className="win-mult">{formatMultiple(result.multiple)}</div>
        <div className="win-meta">
          <span>{option}</span>
          <span>
            Settled at {result.settle.toLocaleString(undefined, { minimumFractionDigits: dec, maximumFractionDigits: dec })} · {formatClock(result.expiry)}
          </span>
        </div>
        <div className="win-actions">
          <button className="win-share" onClick={share}>
            Share on X
          </button>
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

"use client";
// In-house price chart: live median price, expected-move cone to expiry, strikes, breakeven and open positions.
import { useEffect, useMemo, useRef, useState } from "react";
import type { Sample } from "@/lib/feeds";
import type { Side } from "@/lib/pricing";

const YEAR_MS = 365 * 24 * 60 * 60_000;
const MIN = 60_000;
export const LOOKBACKS = [
  { label: "15m", ms: 15 * MIN, tick: 5 * MIN },
  { label: "1h", ms: 60 * MIN, tick: 15 * MIN },
  { label: "4h", ms: 240 * MIN, tick: 60 * MIN },
] as const;

export type ChartPosition = { id: string; side: Side; strike: number; premium: number };

type Props = {
  series: Sample[];
  now: number;
  spot: number | null;
  sigma: number;
  expiry: number;
  side: Side;
  strike: number | null;
  breakeven: number | null;
  positions: ChartPosition[];
  decimals: number;
};

const H = 340;
const M = { top: 18, right: 84, bottom: 28, left: 8 };

function niceStep(range: number, target: number): number {
  const raw = range / target;
  const mag = 10 ** Math.floor(Math.log10(raw));
  const n = raw / mag;
  return (n < 1.5 ? 1 : n < 3 ? 2 : n < 7 ? 5 : 10) * mag;
}

const timeLabel = (t: number) => new Date(t).toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" });

export default function Chart({ series, now, spot, sigma, expiry, side, strike, breakeven, positions, decimals }: Props) {
  const box = useRef<HTMLDivElement>(null);
  const [w, setW] = useState(640);
  const [lb, setLb] = useState(1);
  const [hoverX, setHoverX] = useState<number | null>(null);

  useEffect(() => {
    const el = box.current;
    if (!el) return;
    const ro = new ResizeObserver(([e]) => setW(Math.max(280, Math.floor(e.contentRect.width))));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  const look = LOOKBACKS[lb];
  const x0 = now - look.ms;
  const x1 = now + Math.min(Math.max(expiry - now, 0), look.ms);
  const plotW = w - M.left - M.right;
  const plotH = H - M.top - M.bottom;
  const fmt = (p: number) => p.toLocaleString(undefined, { minimumFractionDigits: decimals, maximumFractionDigits: decimals });

  const pts = useMemo(() => {
    const vis = series.filter((s) => s.t >= x0 && s.t <= now);
    const buckets = Math.max(60, Math.floor(plotW / 1.5));
    const size = (now - x0) / buckets;
    const out: Sample[] = [];
    let cur = -1;
    for (const s of vis) {
      const b = Math.floor((s.t - x0) / size);
      if (b !== cur) {
        out.push(s);
        cur = b;
      } else out[out.length - 1] = s;
    }
    return out;
  }, [series, x0, now, plotW]);

  const cone = useMemo(() => {
    if (!spot || x1 <= now) return [] as { t: number; hi: number; lo: number }[];
    const steps = 24;
    return Array.from({ length: steps + 1 }, (_, i) => {
      const t = now + ((x1 - now) * i) / steps;
      const m = spot * sigma * Math.sqrt((t - now) / YEAR_MS);
      return { t, hi: spot + m, lo: spot - m };
    });
  }, [spot, sigma, now, x1]);

  // Y range: visible prices, the cone at its widest, and the selected strike and breakeven.
  const [y0, y1] = useMemo(() => {
    const vals = pts.map((p) => p.p);
    if (spot) vals.push(spot);
    if (cone.length) vals.push(cone[cone.length - 1].hi, cone[cone.length - 1].lo);
    if (strike !== null) vals.push(strike);
    if (breakeven !== null) vals.push(breakeven);
    if (!vals.length) return [0, 1];
    let lo = Math.min(...vals);
    let hi = Math.max(...vals);
    if (hi - lo < (spot ?? hi) * 0.001) {
      const mid = (hi + lo) / 2;
      lo = mid * 0.9995;
      hi = mid * 1.0005;
    }
    const pad = (hi - lo) * 0.08;
    return [lo - pad, hi + pad];
  }, [pts, spot, cone, strike, breakeven]);

  const X = (t: number) => M.left + ((t - x0) / (x1 - x0)) * plotW;
  const Y = (p: number) => M.top + (1 - (p - y0) / (y1 - y0)) * plotH;
  const inY = (p: number) => p >= y0 && p <= y1;

  const line = pts.map((p, i) => `${i ? "L" : "M"}${X(p.t).toFixed(1)},${Y(p.p).toFixed(1)}`).join("");
  const last = pts[pts.length - 1];
  const area = last ? `${line}L${X(last.t).toFixed(1)},${M.top + plotH}L${X(pts[0].t).toFixed(1)},${M.top + plotH}Z` : "";
  const coneHi = cone.map((c) => `${X(c.t).toFixed(1)},${Y(c.hi).toFixed(1)}`);
  const coneLo = cone.map((c) => `${X(c.t).toFixed(1)},${Y(c.lo).toFixed(1)}`);
  const conePoly = cone.length ? `${coneHi.join(" ")} ${[...coneLo].reverse().join(" ")}` : "";

  const yStep = niceStep(y1 - y0, 5);
  const yTicks: number[] = [];
  for (let v = Math.ceil(y0 / yStep) * yStep; v <= y1; v += yStep) yTicks.push(v);
  const xTicks: number[] = [];
  for (let t = Math.ceil(x0 / look.tick) * look.tick; t <= x1; t += look.tick) xTicks.push(t);

  const tagYs = [spot, strike !== null && inY(strike) ? strike : null, breakeven !== null && inY(breakeven) ? breakeven : null]
    .filter((v): v is number => v !== null)
    .map(Y);
  const underTag = (y: number) => tagYs.some((ty) => Math.abs(ty - y) < 14);

  const sideColor = side === "call" ? "var(--mint)" : "var(--orange)";
  const expiryVisible = expiry <= x1;

  // Hover: nearest past point.
  let hover: Sample | null = null;
  if (hoverX !== null && pts.length) {
    const t = x0 + ((hoverX - M.left) / plotW) * (x1 - x0);
    if (t <= now + 1000) {
      let lo = 0;
      let hi = pts.length - 1;
      while (hi - lo > 1) {
        const mid = (lo + hi) >> 1;
        if (pts[mid].t < t) lo = mid;
        else hi = mid;
      }
      hover = Math.abs(pts[lo].t - t) < Math.abs(pts[hi].t - t) ? pts[lo] : pts[hi];
    }
  }

  const tag = (y: number, text: string, fill: string, color: string) => (
    <g transform={`translate(${w - M.right + 4},${y})`}>
      <rect x={0} y={-10} width={M.right - 8} height={20} rx={6} fill={fill} />
      <text x={(M.right - 8) / 2} y={4} textAnchor="middle" fontSize={11.5} fontWeight={600} fill={color}>
        {text}
      </text>
    </g>
  );

  return (
    <div className="chart" ref={box}>
      <div className="chart-bar">
        <div className="seg small" role="group" aria-label="Chart range">
          {LOOKBACKS.map((l, i) => (
            <button key={l.label} className={i === lb ? "on" : ""} onClick={() => setLb(i)}>
              {l.label}
            </button>
          ))}
        </div>
        <span className="legend">
          <i className="sw cone" aria-hidden="true" /> ±1σ to expiry
          <i className="sw settle" aria-hidden="true" /> settlement window
        </span>
      </div>
      <svg
        width={w}
        height={H}
        role="img"
        aria-label={`Price chart${spot ? `, last ${fmt(spot)}` : ""}`}
        onPointerMove={(e) => setHoverX(e.clientX - e.currentTarget.getBoundingClientRect().left)}
        onPointerLeave={() => setHoverX(null)}
        style={{ touchAction: "pan-y", display: "block" }}
      >
        <defs>
          <clipPath id="plot">
            <rect x={M.left} y={M.top} width={plotW} height={plotH} />
          </clipPath>
        </defs>

        {yTicks.map((v) => (
          <g key={v}>
            <line x1={M.left} x2={M.left + plotW} y1={Y(v)} y2={Y(v)} stroke="var(--line)" strokeWidth={1} />
            {!underTag(Y(v)) && (
              <text x={w - M.right + 8} y={Y(v) + 4} fontSize={11} fill="var(--muted)">
                {fmt(v)}
              </text>
            )}
          </g>
        ))}
        {xTicks.map((t) => (
          <text key={t} x={X(t)} y={H - 8} fontSize={11} fill="var(--muted)" textAnchor="middle">
            {timeLabel(t)}
          </text>
        ))}

        <g clipPath="url(#plot)">
          {expiryVisible && (
            <rect
              x={X(expiry - 5 * MIN)}
              y={M.top}
              width={Math.max(X(expiry) - X(expiry - 5 * MIN), 1)}
              height={plotH}
              fill="rgba(143,245,210,0.07)"
            />
          )}
          {conePoly && <polygon points={conePoly} fill="rgba(143,245,210,0.06)" />}
          {coneHi.length > 0 && (
            <>
              <polyline points={coneHi.join(" ")} fill="none" stroke="var(--mint)" strokeOpacity={0.35} strokeDasharray="3 4" />
              <polyline points={coneLo.join(" ")} fill="none" stroke="var(--mint)" strokeOpacity={0.35} strokeDasharray="3 4" />
            </>
          )}
          <line x1={X(now)} x2={X(now)} y1={M.top} y2={M.top + plotH} stroke="var(--line)" strokeDasharray="2 3" />

          {positions.filter((p) => inY(p.strike)).map((p) => (
            <g key={p.id}>
              <line
                x1={M.left}
                x2={M.left + plotW}
                y1={Y(p.strike)}
                y2={Y(p.strike)}
                stroke={p.side === "call" ? "var(--mint)" : "var(--orange)"}
                strokeOpacity={0.45}
              />
              <text x={M.left + 6} y={Y(p.strike) - 5} fontSize={11} fill={p.side === "call" ? "var(--mint)" : "var(--orange)"}>
                {p.side === "call" ? "Call" : "Put"} {fmt(p.strike)} · ${p.premium.toFixed(0)}
              </text>
            </g>
          ))}

          {breakeven !== null && inY(breakeven) && (
            <line x1={M.left} x2={M.left + plotW} y1={Y(breakeven)} y2={Y(breakeven)} stroke="var(--muted)" strokeDasharray="1 4" />
          )}
          {strike !== null && inY(strike) && (
            <line x1={M.left} x2={M.left + plotW} y1={Y(strike)} y2={Y(strike)} stroke={sideColor} strokeDasharray="6 5" strokeWidth={1.5} />
          )}

          {area && <path d={area} fill="rgba(143,245,210,0.05)" />}
          {line && <path d={line} fill="none" stroke="var(--mint)" strokeWidth={1.75} strokeLinejoin="round" />}
          {last && <circle cx={X(last.t)} cy={Y(last.p)} r={3.5} fill="var(--mint)" />}
          {spot && <line x1={X(now)} x2={M.left + plotW} y1={Y(spot)} y2={Y(spot)} stroke="var(--mint)" strokeOpacity={0.4} strokeDasharray="2 3" />}

          {hover && (
            <g>
              <line x1={X(hover.t)} x2={X(hover.t)} y1={M.top} y2={M.top + plotH} stroke="var(--muted)" strokeOpacity={0.6} />
              <circle cx={X(hover.t)} cy={Y(hover.p)} r={4} fill="var(--bg)" stroke="var(--mint)" strokeWidth={2} />
            </g>
          )}
        </g>

        {expiryVisible && (
          <g>
            <line x1={X(expiry)} x2={X(expiry)} y1={M.top} y2={M.top + plotH} stroke="var(--text)" strokeOpacity={0.5} />
            <text x={X(expiry) - 6} y={M.top + 12} fontSize={11} fill="var(--text)" textAnchor="end">
              Expiry {timeLabel(expiry)}
            </text>
          </g>
        )}
        {!expiryVisible && (
          <text x={M.left + plotW - 6} y={M.top + 12} fontSize={11} fill="var(--muted)" textAnchor="end">
            Expiry {timeLabel(expiry)} →
          </text>
        )}

        {breakeven !== null && inY(breakeven) && tag(Y(breakeven), `BE ${fmt(breakeven)}`, "var(--line)", "var(--text)")}
        {strike !== null && inY(strike) && tag(Y(strike), fmt(strike), sideColor, "var(--bg)")}
        {spot && tag(Y(spot), fmt(spot), "var(--mint)", "var(--bg)")}

        {hover && (
          <g transform={`translate(${Math.min(X(hover.t) + 10, M.left + plotW - 132)},${M.top + 8})`}>
            <rect width={124} height={40} rx={8} fill="var(--bg)" stroke="var(--line)" />
            <text x={10} y={16} fontSize={11} fill="var(--muted)">
              {new Date(hover.t).toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit", second: "2-digit" })}
            </text>
            <text x={10} y={32} fontSize={13} fontWeight={600} fill="var(--text)">
              {fmt(hover.p)}
            </text>
          </g>
        )}
      </svg>
    </div>
  );
}

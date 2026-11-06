"use client";
// Live tick chart on canvas. Step line of 250ms medians, drag to pan, wheel/pinch to zoom, double-click to go live.
import { useEffect, useRef } from "react";
import type { MutableRefObject } from "react";
import type { Asset, Sample, Series } from "@/lib/feeds";
import type { Side } from "@/lib/pricing";

const YEAR_MS = 365 * 24 * 60 * 60_000;
const C = {
  text: "#EAF4F1",
  muted: "#7F9792",
  grid: "rgba(234,244,241,0.07)",
  line: "#EAF4F1",
  mint: "#8FF5D2",
  orange: "#FFB27A",
  bg: "#0B1513",
  tagBg: "#1A2E2A",
};
const M = { top: 12, right: 78, bottom: 26, left: 0 };
const MIN_SPAN = 20_000;
const MAX_SPAN = 5 * 60 * 60_000;
const TIME_STEPS = [1, 2, 5, 10, 15, 30, 60, 120, 300, 600, 900, 1800, 3600, 7200].map((s) => s * 1000);

export type ChartPosition = { id: string; side: Side; strike: number; label?: string };

type Props = {
  asset: Asset;
  samples: MutableRefObject<Series>;
  history: MutableRefObject<Series>;
  spot: number | null;
  sigma: number;
  expiry: number;
  settleWindow: number;
  side: Side;
  strike: number | null;
  positions: ChartPosition[];
  nextExpiry?: number | null; // drawn faintly while the chart follows a closing round
  urgent?: boolean; // last 10s of a round I hold: the expiry line and settlement band pulse
  flash?: { price: number; until: number } | null; // settlement price tag on the axis
  decimals: number;
  defaultSpan: number;
  follow: boolean;
  onFollowChange: (live: boolean) => void;
};

function niceStep(range: number, target: number): number {
  const raw = range / target;
  const mag = 10 ** Math.floor(Math.log10(raw));
  const n = raw / mag;
  return (n < 1.5 ? 1 : n < 3 ? 2 : n < 7 ? 5 : 10) * mag;
}

// First index with t >= x.
function lowerBound(a: Sample[], x: number): number {
  let lo = 0;
  let hi = a.length;
  while (lo < hi) {
    const m = (lo + hi) >> 1;
    if (a[m].t < x) lo = m + 1;
    else hi = m;
  }
  return lo;
}

function roundRect(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, r: number) {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
}

export default function Chart(props: Props) {
  const wrap = useRef<HTMLDivElement>(null);
  const canvas = useRef<HTMLCanvasElement>(null);
  const live = useRef(props); // latest props for the draw loop
  live.current = props;
  // y0/y1: drawn range (eased). t0/t1: target range. manualY: the price axis was zoomed by hand.
  const view = useRef({ span: props.defaultSpan, right: 0, y0: 0, y1: 0, t0: 0, t1: 0, ready: false, manualY: false });
  const pointer = useRef<{ x: number; y: number } | null>(null);
  const drag = useRef<{ x: number; y: number; right: number; y0: number; y1: number; axis: boolean } | null>(null);
  const pinch = useRef<{ d: number; span: number } | null>(null);
  const touches = useRef(new Map<number, { x: number; y: number }>());

  // New asset or tenor: reset the zoom and y-range.
  useEffect(() => {
    view.current.span = props.defaultSpan;
    view.current.ready = false;
    view.current.manualY = false;
  }, [props.asset, props.defaultSpan]);

  useEffect(() => {
    if (props.follow) {
      view.current.ready = false;
      view.current.manualY = false;
    }
  }, [props.follow]);

  useEffect(() => {
    const cv = canvas.current!;
    const box = wrap.current!;
    const ctx = cv.getContext("2d")!;
    let w = 0;
    let h = 0;
    let raf = 0;

    const resize = () => {
      const r = box.getBoundingClientRect();
      const dpr = window.devicePixelRatio || 1;
      w = Math.floor(r.width);
      h = Math.floor(r.height);
      cv.width = w * dpr;
      cv.height = h * dpr;
      cv.style.width = `${w}px`;
      cv.style.height = `${h}px`;
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    };
    const ro = new ResizeObserver(resize);
    ro.observe(box);
    resize();

    const motion = window.matchMedia("(prefers-reduced-motion: reduce)");

    // Live view scrolls at a constant pace: "now" sits 78% of the way across.
    const liveRight = (now: number) => now + view.current.span * 0.22;

    const draw = () => {
      raf = requestAnimationFrame(draw);
      const p = live.current;
      const v = view.current;
      const now = Date.now();
      const plotW = w - M.left - M.right;
      const plotH = h - M.top - M.bottom;
      if (plotW < 50 || plotH < 50) return;
      if (p.follow) v.right = liveRight(now);
      const x1 = v.right;
      const x0 = x1 - v.span;
      const X = (t: number) => M.left + ((t - x0) / v.span) * plotW;

      // Visible points: 1-minute history before the live stream, then live samples.
      // Each pixel column keeps its first, low, high and last price so zooming never drops spikes.
      const liveS = p.samples.current[p.asset];
      const histS = p.history.current[p.asset];
      const firstLive = liveS.length ? liveS[0].t : Infinity;
      type Bucket = { x: number; t: number; first: number; lo: number; hi: number; last: number };
      const buckets: Bucket[] = [];
      const pushRange = (arr: Sample[], from: number, to: number) => {
        for (let i = Math.max(0, lowerBound(arr, from) - 1); i < arr.length && arr[i].t <= to; i++) {
          const s = arr[i];
          const x = Math.floor(X(s.t));
          const b = buckets[buckets.length - 1];
          if (b && b.x === x) {
            if (s.p < b.lo) b.lo = s.p;
            if (s.p > b.hi) b.hi = s.p;
            b.last = s.p;
            b.t = s.t;
          } else buckets.push({ x, t: s.t, first: s.p, lo: s.p, hi: s.p, last: s.p });
        }
      };
      pushRange(histS, x0, Math.min(x1, firstLive - 1));
      pushRange(liveS, x0, x1);

      ctx.clearRect(0, 0, w, h);
      if (!buckets.length) {
        ctx.fillStyle = C.muted;
        ctx.font = "500 13px 'Inter Tight', system-ui";
        ctx.textAlign = "center";
        ctx.fillText(p.spot ? "No data in this range" : "Connecting to price feeds…", M.left + plotW / 2, M.top + plotH / 2);
        return;
      }
      const lastB = buckets[buckets.length - 1];
      const last = { t: lastB.t, p: lastB.last };
      const spot = p.spot ?? last.p;

      // Y range: re-fit only when prices leave the comfortable middle or the range gets too loose. Eased.
      if (!v.manualY) {
        let lo = Infinity;
        let hi = -Infinity;
        for (const b of buckets) {
          if (b.x < M.left - 1) continue;
          if (b.lo < lo) lo = b.lo;
          if (b.hi > hi) hi = b.hi;
        }
        if (!Number.isFinite(lo)) {
          lo = last.p;
          hi = last.p;
        }
        lo = Math.min(lo, spot);
        hi = Math.max(hi, spot);
        const minRange = spot * 0.0004;
        if (hi - lo < minRange) {
          const mid = (hi + lo) / 2;
          lo = mid - minRange / 2;
          hi = mid + minRange / 2;
        }
        const near = (k: number) => k > lo - (hi - lo) * 1.2 && k < hi + (hi - lo) * 1.2;
        for (const k of [...(p.strike !== null ? [p.strike] : []), ...p.positions.map((x) => x.strike)]) {
          if (near(k)) {
            lo = Math.min(lo, k);
            hi = Math.max(hi, k);
          }
        }
        const range = v.t1 - v.t0;
        const edge = range * 0.06;
        const refit = !v.ready || lo < v.t0 + edge || hi > v.t1 - edge || hi - lo < range * 0.4;
        if (refit) {
          const pad = (hi - lo) * 0.18;
          v.t0 = lo - pad;
          v.t1 = hi + pad;
        }
        if (!v.ready) {
          v.y0 = v.t0;
          v.y1 = v.t1;
          v.ready = true;
        }
      }
      v.y0 += (v.t0 - v.y0) * 0.18;
      v.y1 += (v.t1 - v.y1) * 0.18;
      const Y = (pr: number) => M.top + (1 - (pr - v.y0) / (v.y1 - v.y0)) * plotH;
      const fmt = (n: number) => n.toLocaleString(undefined, { minimumFractionDigits: p.decimals, maximumFractionDigits: p.decimals });
      ctx.font = "500 11px 'Inter Tight', system-ui";

      // Price-axis labels are skipped where a tag will sit.
      const flashing = p.flash && now < p.flash.until ? [p.flash.price] : [];
      const tagYs = [last.p, ...flashing, ...(p.strike !== null ? [p.strike] : []), ...p.positions.map((x) => x.strike)].map(Y);
      const underTag = (py: number) => tagYs.some((ty) => Math.abs(ty - py) < 17);

      // Grid + price axis.
      const yStep = niceStep(v.y1 - v.y0, Math.max(3, plotH / 80));
      ctx.setLineDash([2, 4]);
      ctx.strokeStyle = C.grid;
      ctx.lineWidth = 1;
      ctx.textAlign = "left";
      ctx.fillStyle = C.muted;
      for (let y = Math.ceil(v.y0 / yStep) * yStep; y <= v.y1; y += yStep) {
        const py = Math.round(Y(y)) + 0.5;
        ctx.beginPath();
        ctx.moveTo(M.left, py);
        ctx.lineTo(M.left + plotW, py);
        ctx.stroke();
        if (!underTag(py)) ctx.fillText(fmt(y), w - M.right + 10, py + 4);
      }
      ctx.setLineDash([]);

      // Time axis.
      const tStep = TIME_STEPS.find((s) => (s / v.span) * plotW >= 90) ?? TIME_STEPS[TIME_STEPS.length - 1];
      ctx.textAlign = "center";
      for (let t = Math.ceil(x0 / tStep) * tStep; t <= x1; t += tStep) {
        const label = new Date(t).toLocaleTimeString(undefined, {
          hour: "numeric",
          minute: "2-digit",
          ...(tStep < 60_000 ? { second: "2-digit" } : {}),
        });
        ctx.fillText(label, X(t), h - 8);
      }
      ctx.strokeStyle = C.grid;
      ctx.beginPath();
      ctx.moveTo(w - M.right + 0.5, M.top);
      ctx.lineTo(w - M.right + 0.5, M.top + plotH);
      ctx.stroke();

      ctx.save();
      ctx.beginPath();
      ctx.rect(M.left, M.top, plotW, plotH);
      ctx.clip();

      // Expiry: settlement band, expected-move cone, expiry line.
      const ex = X(p.expiry);
      // Final seconds: band and line turn orange and breathe (steady orange with reduced motion).
      const urgent = !!p.urgent && p.expiry > now;
      const beat = urgent && !motion.matches ? 0.5 + 0.5 * Math.sin((now / 1000) * Math.PI * 2) : 1;
      if (p.expiry > x0 && p.expiry - p.settleWindow < x1) {
        ctx.fillStyle = urgent ? `rgba(255,178,122,${0.06 + 0.1 * beat})` : "rgba(143,245,210,0.06)";
        ctx.fillRect(X(p.expiry - p.settleWindow), M.top, ex - X(p.expiry - p.settleWindow), plotH);
      }
      if (p.nextExpiry && p.nextExpiry >= x0 && p.nextExpiry <= x1) {
        const nx = Math.round(X(p.nextExpiry)) + 0.5;
        ctx.setLineDash([3, 5]);
        ctx.strokeStyle = "rgba(234,244,241,0.14)";
        ctx.beginPath();
        ctx.moveTo(nx, M.top);
        ctx.lineTo(nx, M.top + plotH);
        ctx.stroke();
        ctx.setLineDash([]);
      }
      if (p.expiry > now && X(now) < M.left + plotW) {
        const steps = 30;
        const end = Math.min(p.expiry, x1);
        const up: [number, number][] = [];
        const dn: [number, number][] = [];
        for (let i = 0; i <= steps; i++) {
          const t = now + ((end - now) * i) / steps;
          const m = spot * p.sigma * Math.sqrt((t - now) / YEAR_MS);
          up.push([X(t), Y(spot + m)]);
          dn.push([X(t), Y(spot - m)]);
        }
        ctx.beginPath();
        up.forEach(([x, y], i) => (i ? ctx.lineTo(x, y) : ctx.moveTo(x, y)));
        [...dn].reverse().forEach(([x, y]) => ctx.lineTo(x, y));
        ctx.closePath();
        ctx.fillStyle = "rgba(143,245,210,0.035)";
        ctx.fill();
        ctx.setLineDash([2, 4]);
        ctx.strokeStyle = "rgba(143,245,210,0.28)";
        for (const edge of [up, dn]) {
          ctx.beginPath();
          edge.forEach(([x, y], i) => (i ? ctx.lineTo(x, y) : ctx.moveTo(x, y)));
          ctx.stroke();
        }
        ctx.setLineDash([]);
      }
      if (p.expiry >= x0 && p.expiry <= x1) {
        ctx.strokeStyle = urgent ? `rgba(255,178,122,${0.5 + 0.45 * beat})` : "rgba(234,244,241,0.45)";
        ctx.lineWidth = urgent ? 1.5 : 1;
        ctx.beginPath();
        ctx.moveTo(Math.round(ex) + 0.5, M.top);
        ctx.lineTo(Math.round(ex) + 0.5, M.top + plotH);
        ctx.stroke();
        ctx.lineWidth = 1;
      }

      // Positions on this expiry and the selected strike.
      for (const pos of p.positions) {
        if (pos.strike < v.y0 || pos.strike > v.y1) continue;
        const py = Math.round(Y(pos.strike)) + 0.5;
        ctx.strokeStyle = pos.side === "call" ? "rgba(143,245,210,0.5)" : "rgba(255,178,122,0.55)";
        ctx.beginPath();
        ctx.moveTo(M.left, py);
        ctx.lineTo(M.left + plotW, py);
        ctx.stroke();
      }
      const sideColor = p.side === "call" ? C.mint : C.orange;
      if (p.strike !== null && p.strike > v.y0 && p.strike < v.y1) {
        const py = Math.round(Y(p.strike)) + 0.5;
        ctx.setLineDash([5, 4]);
        ctx.strokeStyle = sideColor;
        ctx.beginPath();
        ctx.moveTo(M.left, py);
        ctx.lineTo(M.left + plotW, py);
        ctx.stroke();
        ctx.setLineDash([]);
      }

      // Step line through each pixel column's first, low, high and last price, plus a soft area fill.
      const nowX = Math.min(X(now), M.left + plotW);
      const line = new Path2D();
      line.moveTo(buckets[0].x, Y(buckets[0].first));
      let prev = buckets[0].first;
      for (const b of buckets) {
        line.lineTo(b.x, Y(prev));
        line.lineTo(b.x, Y(b.first));
        if (b.hi !== b.lo) {
          line.lineTo(b.x, Y(b.hi));
          line.lineTo(b.x, Y(b.lo));
        }
        line.lineTo(b.x, Y(b.last));
        prev = b.last;
      }
      const lastX = Math.max(lastB.x, nowX);
      line.lineTo(lastX, Y(last.p));
      const area = new Path2D(line);
      area.lineTo(lastX, M.top + plotH);
      area.lineTo(buckets[0].x, M.top + plotH);
      area.closePath();
      ctx.fillStyle = "rgba(234,244,241,0.035)";
      ctx.fill(area);
      ctx.strokeStyle = C.line;
      ctx.lineWidth = 1.5;
      ctx.lineJoin = "miter";
      ctx.stroke(line);
      ctx.lineWidth = 1;

      // Live price: dotted guide, pulsing dot.
      const dotX = lastX;
      const dotY = Y(last.p);
      ctx.setLineDash([1, 3]);
      ctx.strokeStyle = "rgba(143,245,210,0.5)";
      ctx.beginPath();
      ctx.moveTo(dotX, Math.round(dotY) + 0.5);
      ctx.lineTo(M.left + plotW, Math.round(dotY) + 0.5);
      ctx.stroke();
      ctx.setLineDash([]);
      if (!motion.matches) {
        const pulse = (now % 1600) / 1600;
        ctx.fillStyle = `rgba(143,245,210,${0.35 * (1 - pulse)})`;
        ctx.beginPath();
        ctx.arc(dotX, dotY, 3 + pulse * 9, 0, Math.PI * 2);
        ctx.fill();
      }
      ctx.fillStyle = C.mint;
      ctx.beginPath();
      ctx.arc(dotX, dotY, 3.5, 0, Math.PI * 2);
      ctx.fill();

      // Position labels on their lines, just left of the price axis: "C 101,520 · 3.1× now".
      ctx.font = "600 11px 'Inter Tight', system-ui";
      ctx.textAlign = "right";
      for (const pos of p.positions) {
        if (!pos.label || pos.strike < v.y0 || pos.strike > v.y1) continue;
        const py = Math.round(Y(pos.strike));
        const tw = ctx.measureText(pos.label).width + 10;
        const lx = M.left + plotW - 6;
        const ly = py < M.top + 20 ? py + 4 : py - 18;
        roundRect(ctx, lx - tw, ly, tw, 16, 3);
        ctx.fillStyle = "rgba(11,21,19,0.85)";
        ctx.fill();
        ctx.fillStyle = pos.side === "call" ? C.mint : C.orange;
        ctx.fillText(pos.label, lx - 5, ly + 12);
      }

      // Crosshair.
      const hover = pointer.current && !drag.current ? pointer.current : null;
      if (hover && hover.x < M.left + plotW && hover.y > M.top && hover.y < M.top + plotH) {
        ctx.setLineDash([3, 3]);
        ctx.strokeStyle = "rgba(234,244,241,0.3)";
        ctx.beginPath();
        ctx.moveTo(Math.round(hover.x) + 0.5, M.top);
        ctx.lineTo(Math.round(hover.x) + 0.5, M.top + plotH);
        ctx.moveTo(M.left, Math.round(hover.y) + 0.5);
        ctx.lineTo(M.left + plotW, Math.round(hover.y) + 0.5);
        ctx.stroke();
        ctx.setLineDash([]);
      }
      ctx.restore();

      // Axis tags.
      const tag = (y: number, text: string, bg: string, fg: string, outline = false) => {
        const th = 20;
        const ty = Math.max(M.top, Math.min(M.top + plotH - th, y - th / 2));
        roundRect(ctx, w - M.right + 4, ty, M.right - 8, th, 4);
        if (outline) {
          ctx.fillStyle = C.bg;
          ctx.fill();
          ctx.strokeStyle = bg;
          ctx.stroke();
        } else {
          ctx.fillStyle = bg;
          ctx.fill();
        }
        ctx.fillStyle = fg;
        ctx.font = "600 11px 'Inter Tight', system-ui";
        ctx.textAlign = "center";
        ctx.fillText(text, w - M.right / 2, ty + 14);
      };
      for (const pos of p.positions) {
        if (pos.strike > v.y0 && pos.strike < v.y1) tag(Y(pos.strike), fmt(pos.strike), pos.side === "call" ? C.mint : C.orange, pos.side === "call" ? C.mint : C.orange, true);
      }
      if (p.strike !== null && p.strike > v.y0 && p.strike < v.y1) tag(Y(p.strike), fmt(p.strike), sideColor, sideColor, true);
      tag(dotY, fmt(last.p), C.mint, C.bg);
      if (p.flash && now < p.flash.until && p.flash.price > v.y0 && p.flash.price < v.y1) {
        const fade = motion.matches ? 1 : Math.min(1, (p.flash.until - now) / 400);
        ctx.globalAlpha = fade;
        tag(Y(p.flash.price), fmt(p.flash.price), C.text, C.bg);
        ctx.globalAlpha = 1;
      }
      if (hover && hover.x < M.left + plotW && hover.y > M.top && hover.y < M.top + plotH) {
        const hp = v.y0 + (1 - (hover.y - M.top) / plotH) * (v.y1 - v.y0);
        tag(hover.y, fmt(hp), C.tagBg, C.text);
        const ht = x0 + ((hover.x - M.left) / plotW) * v.span;
        const label = new Date(ht).toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit", second: "2-digit" });
        ctx.font = "600 11px 'Inter Tight', system-ui";
        const tw = ctx.measureText(label).width + 14;
        const tx = Math.max(M.left, Math.min(M.left + plotW - tw, hover.x - tw / 2));
        roundRect(ctx, tx, h - M.bottom + 4, tw, 18, 4);
        ctx.fillStyle = C.tagBg;
        ctx.fill();
        ctx.fillStyle = C.text;
        ctx.textAlign = "center";
        ctx.fillText(label, tx + tw / 2, h - M.bottom + 17);
      }

      // Expiry label.
      if (p.expiry >= x0 && p.expiry <= x1) {
        const label = `Expiry ${new Date(p.expiry).toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit", second: p.expiry % 60_000 ? "2-digit" : undefined })}`;
        ctx.font = "600 11px 'Inter Tight', system-ui";
        const tw = ctx.measureText(label).width + 14;
        roundRect(ctx, Math.min(ex - tw / 2, M.left + plotW - tw), M.top, tw, 18, 4);
        ctx.fillStyle = C.tagBg;
        ctx.fill();
        ctx.fillStyle = C.text;
        ctx.textAlign = "center";
        ctx.fillText(label, Math.min(ex, M.left + plotW - tw / 2), M.top + 13);
      }
    };
    raf = requestAnimationFrame(draw);

    // Interaction.
    const plotWidth = () => w - M.left - M.right;
    const local = (e: PointerEvent | WheelEvent) => {
      const r = cv.getBoundingClientRect();
      return { x: e.clientX - r.left, y: e.clientY - r.top };
    };
    const unfollow = () => {
      if (live.current.follow) live.current.onFollowChange(false);
    };
    const zoomAt = (x: number, factor: number) => {
      const v = view.current;
      const span = Math.min(MAX_SPAN, Math.max(MIN_SPAN, v.span * factor));
      if (live.current.follow) {
        v.span = span;
        return;
      }
      const t = v.right - v.span + ((x - M.left) / plotWidth()) * v.span;
      v.right = t + (v.right - t) * (span / v.span);
      v.span = span;
    };
    const inAxis = (x: number) => x > w - M.right;
    const scaleY = (factor: number) => {
      const v = view.current;
      v.manualY = true;
      const mid = (v.t0 + v.t1) / 2;
      const half = ((v.t1 - v.t0) / 2) * factor;
      v.t0 = mid - half;
      v.t1 = mid + half;
    };
    const onDown = (e: PointerEvent) => {
      cv.setPointerCapture(e.pointerId);
      const pt = local(e);
      touches.current.set(e.pointerId, pt);
      if (touches.current.size === 2) {
        const [a, b] = [...touches.current.values()];
        pinch.current = { d: Math.hypot(a.x - b.x, a.y - b.y), span: view.current.span };
        drag.current = null;
      } else {
        const v = view.current;
        drag.current = { x: pt.x, y: pt.y, right: v.right, y0: v.t0, y1: v.t1, axis: inAxis(pt.x) };
      }
    };
    const onMove = (e: PointerEvent) => {
      const pt = local(e);
      pointer.current = pt;
      cv.style.cursor = drag.current?.axis || (!drag.current && inAxis(pt.x)) ? "ns-resize" : drag.current ? "grabbing" : "crosshair";
      if (touches.current.has(e.pointerId)) touches.current.set(e.pointerId, pt);
      if (pinch.current && touches.current.size === 2) {
        const [a, b] = [...touches.current.values()];
        const d = Math.hypot(a.x - b.x, a.y - b.y);
        if (d > 0) view.current.span = Math.min(MAX_SPAN, Math.max(MIN_SPAN, pinch.current.span * (pinch.current.d / d)));
        return;
      }
      const dr = drag.current;
      if (!dr) return;
      const v = view.current;
      if (dr.axis) {
        // Drag the price bar: down stretches the scale out, up zooms in.
        const factor = Math.exp((pt.y - dr.y) * 0.006);
        const mid = (dr.y0 + dr.y1) / 2;
        const half = ((dr.y1 - dr.y0) / 2) * factor;
        v.manualY = true;
        v.t0 = mid - half;
        v.t1 = mid + half;
        return;
      }
      const dx = pt.x - dr.x;
      const dy = pt.y - dr.y;
      if (Math.abs(dx) > 2) {
        unfollow();
        v.right = Math.min(Date.now() + v.span * 0.9, dr.right - (dx / plotWidth()) * v.span);
      }
      if (v.manualY && Math.abs(dy) > 2) {
        const perPx = (dr.y1 - dr.y0) / (h - M.top - M.bottom);
        v.t0 = dr.y0 + dy * perPx;
        v.t1 = dr.y1 + dy * perPx;
        v.y0 = v.t0;
        v.y1 = v.t1;
      }
    };
    const onUp = (e: PointerEvent) => {
      touches.current.delete(e.pointerId);
      if (touches.current.size < 2) pinch.current = null;
      drag.current = null;
    };
    const onLeave = () => {
      pointer.current = null;
    };
    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      const pt = local(e);
      if (inAxis(pt.x)) {
        scaleY(Math.exp(e.deltaY * 0.002));
        return;
      }
      if (Math.abs(e.deltaX) > Math.abs(e.deltaY)) {
        unfollow();
        view.current.right += (e.deltaX / plotWidth()) * view.current.span;
        return;
      }
      zoomAt(pt.x, Math.exp(e.deltaY * 0.0015));
    };
    const onDbl = (e: MouseEvent) => {
      const r = cv.getBoundingClientRect();
      if (inAxis(e.clientX - r.left)) {
        view.current.manualY = false; // double-click the price bar: auto-fit again
        view.current.ready = false;
        return;
      }
      view.current.manualY = false;
      view.current.ready = false;
      live.current.onFollowChange(true);
    };
    cv.addEventListener("pointerdown", onDown);
    cv.addEventListener("pointermove", onMove);
    cv.addEventListener("pointerup", onUp);
    cv.addEventListener("pointercancel", onUp);
    cv.addEventListener("pointerleave", onLeave);
    cv.addEventListener("wheel", onWheel, { passive: false });
    cv.addEventListener("dblclick", onDbl);

    return () => {
      cancelAnimationFrame(raf);
      ro.disconnect();
      cv.removeEventListener("pointerdown", onDown);
      cv.removeEventListener("pointermove", onMove);
      cv.removeEventListener("pointerup", onUp);
      cv.removeEventListener("pointercancel", onUp);
      cv.removeEventListener("pointerleave", onLeave);
      cv.removeEventListener("wheel", onWheel);
      cv.removeEventListener("dblclick", onDbl);
    };
  }, []);

  return (
    <div className="chart" ref={wrap}>
      <canvas
        ref={canvas}
        role="img"
        aria-label={`${props.asset} price chart${props.spot ? `, last ${props.spot.toFixed(props.decimals)}` : ""}. Drag to pan, scroll to zoom, drag or scroll the price bar to zoom prices, double-click to return to live.`}
        style={{ touchAction: "none", cursor: "crosshair", display: "block" }}
      />
      <span className="watermark" aria-hidden="true">
        expiry
      </span>
    </div>
  );
}

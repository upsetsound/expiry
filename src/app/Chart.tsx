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

export type ChartPosition = { id: string; side: Side; strike: number };

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
  const view = useRef({ span: props.defaultSpan, right: 0, y0: 0, y1: 0, ready: false });
  const pointer = useRef<{ x: number; y: number } | null>(null);
  const drag = useRef<{ x: number; right: number } | null>(null);
  const pinch = useRef<{ d: number; span: number } | null>(null);
  const touches = useRef(new Map<number, { x: number; y: number }>());

  // New asset or tenor: reset the zoom and y-range.
  useEffect(() => {
    view.current.span = props.defaultSpan;
    view.current.ready = false;
  }, [props.asset, props.defaultSpan]);

  useEffect(() => {
    if (props.follow) view.current.ready = false;
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

    const liveRight = (now: number) => {
      const { span } = view.current;
      const { expiry } = live.current;
      let right = now + span * 0.2;
      if (expiry > now && expiry - now < span * 0.7) right = Math.max(right, expiry + span * 0.06);
      return right;
    };

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

      // Visible points: 1-minute history before the live stream, then live samples. One point per pixel at most.
      const liveS = p.samples.current[p.asset];
      const histS = p.history.current[p.asset];
      const firstLive = liveS.length ? liveS[0].t : Infinity;
      const pts: Sample[] = [];
      const pushRange = (arr: Sample[], from: number, to: number) => {
        let lastPx = -1;
        for (let i = Math.max(0, lowerBound(arr, from) - 1); i < arr.length && arr[i].t <= to; i++) {
          const px = Math.round(X(arr[i].t));
          if (px === lastPx && pts.length) pts[pts.length - 1] = arr[i];
          else pts.push(arr[i]);
          lastPx = px;
        }
      };
      pushRange(histS, x0, Math.min(x1, firstLive - 1));
      pushRange(liveS, x0, x1);

      ctx.clearRect(0, 0, w, h);
      if (!pts.length) {
        ctx.fillStyle = C.muted;
        ctx.font = "500 13px 'Inter Tight', system-ui";
        ctx.textAlign = "center";
        ctx.fillText(p.spot ? "No data in this range" : "Connecting to price feeds…", M.left + plotW / 2, M.top + plotH / 2);
        return;
      }
      const last = pts[pts.length - 1];
      const spot = p.spot ?? last.p;

      // Y range from what's on screen, plus a nearby strike. Eased so it doesn't jump.
      let lo = Infinity;
      let hi = -Infinity;
      for (const s of pts) {
        if (s.p < lo) lo = s.p;
        if (s.p > hi) hi = s.p;
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
      const pad = (hi - lo) * 0.14;
      const ty0 = lo - pad;
      const ty1 = hi + pad;
      if (!v.ready) {
        v.y0 = ty0;
        v.y1 = ty1;
        v.ready = true;
      } else {
        v.y0 += (ty0 - v.y0) * 0.12;
        v.y1 += (ty1 - v.y1) * 0.12;
      }
      const Y = (pr: number) => M.top + (1 - (pr - v.y0) / (v.y1 - v.y0)) * plotH;
      const fmt = (n: number) => n.toLocaleString(undefined, { minimumFractionDigits: p.decimals, maximumFractionDigits: p.decimals });
      ctx.font = "500 11px 'Inter Tight', system-ui";

      // Price-axis labels are skipped where a tag will sit.
      const tagYs = [last.p, ...(p.strike !== null ? [p.strike] : []), ...p.positions.map((x) => x.strike)].map(Y);
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
      if (p.expiry > x0 && p.expiry - p.settleWindow < x1) {
        ctx.fillStyle = "rgba(143,245,210,0.06)";
        ctx.fillRect(X(p.expiry - p.settleWindow), M.top, ex - X(p.expiry - p.settleWindow), plotH);
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
        ctx.strokeStyle = "rgba(234,244,241,0.45)";
        ctx.beginPath();
        ctx.moveTo(Math.round(ex) + 0.5, M.top);
        ctx.lineTo(Math.round(ex) + 0.5, M.top + plotH);
        ctx.stroke();
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

      // Area + step line.
      ctx.beginPath();
      ctx.moveTo(X(pts[0].t), Y(pts[0].p));
      for (let i = 1; i < pts.length; i++) {
        ctx.lineTo(X(pts[i].t), Y(pts[i - 1].p));
        ctx.lineTo(X(pts[i].t), Y(pts[i].p));
      }
      const lastX = X(last.t);
      ctx.lineTo(Math.min(X(now), M.left + plotW), Y(last.p));
      const linePath = new Path2D();
      linePath.moveTo(X(pts[0].t), Y(pts[0].p));
      for (let i = 1; i < pts.length; i++) {
        linePath.lineTo(X(pts[i].t), Y(pts[i - 1].p));
        linePath.lineTo(X(pts[i].t), Y(pts[i].p));
      }
      linePath.lineTo(Math.max(lastX, Math.min(X(now), M.left + plotW)), Y(last.p));
      ctx.lineTo(Math.max(lastX, Math.min(X(now), M.left + plotW)), M.top + plotH);
      ctx.lineTo(X(pts[0].t), M.top + plotH);
      ctx.closePath();
      ctx.fillStyle = "rgba(234,244,241,0.035)";
      ctx.fill();
      ctx.strokeStyle = C.line;
      ctx.lineWidth = 1.6;
      ctx.lineJoin = "round";
      ctx.stroke(linePath);
      ctx.lineWidth = 1;

      // Live price: dotted guide, pulsing dot.
      const dotX = Math.max(lastX, Math.min(X(now), M.left + plotW));
      const dotY = Y(last.p);
      ctx.setLineDash([1, 3]);
      ctx.strokeStyle = "rgba(143,245,210,0.5)";
      ctx.beginPath();
      ctx.moveTo(dotX, Math.round(dotY) + 0.5);
      ctx.lineTo(M.left + plotW, Math.round(dotY) + 0.5);
      ctx.stroke();
      ctx.setLineDash([]);
      const pulse = (now % 1600) / 1600;
      ctx.fillStyle = `rgba(143,245,210,${0.35 * (1 - pulse)})`;
      ctx.beginPath();
      ctx.arc(dotX, dotY, 3 + pulse * 9, 0, Math.PI * 2);
      ctx.fill();
      ctx.fillStyle = C.mint;
      ctx.beginPath();
      ctx.arc(dotX, dotY, 3.5, 0, Math.PI * 2);
      ctx.fill();

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
    const onDown = (e: PointerEvent) => {
      cv.setPointerCapture(e.pointerId);
      const pt = local(e);
      touches.current.set(e.pointerId, pt);
      if (touches.current.size === 2) {
        const [a, b] = [...touches.current.values()];
        pinch.current = { d: Math.hypot(a.x - b.x, a.y - b.y), span: view.current.span };
        drag.current = null;
      } else {
        drag.current = { x: pt.x, right: view.current.right };
      }
    };
    const onMove = (e: PointerEvent) => {
      const pt = local(e);
      pointer.current = pt;
      if (touches.current.has(e.pointerId)) touches.current.set(e.pointerId, pt);
      if (pinch.current && touches.current.size === 2) {
        const [a, b] = [...touches.current.values()];
        const d = Math.hypot(a.x - b.x, a.y - b.y);
        if (d > 0) view.current.span = Math.min(MAX_SPAN, Math.max(MIN_SPAN, pinch.current.span * (pinch.current.d / d)));
        return;
      }
      if (drag.current) {
        const dx = pt.x - drag.current.x;
        if (Math.abs(dx) > 2) {
          unfollow();
          view.current.right = Math.min(Date.now() + view.current.span * 0.9, drag.current.right - (dx / plotWidth()) * view.current.span);
        }
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
      if (Math.abs(e.deltaX) > Math.abs(e.deltaY)) {
        unfollow();
        view.current.right += (e.deltaX / plotWidth()) * view.current.span;
        return;
      }
      zoomAt(pt.x, Math.exp(e.deltaY * 0.0015));
    };
    const onDbl = () => live.current.onFollowChange(true);
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
        aria-label={`${props.asset} price chart${props.spot ? `, last ${props.spot.toFixed(props.decimals)}` : ""}. Drag to pan, scroll to zoom, double-click to return to live.`}
        style={{ touchAction: "none", cursor: "crosshair", display: "block" }}
      />
      <span className="watermark" aria-hidden="true">
        expiry
      </span>
    </div>
  );
}

// Expiry rounds. Every tenor expires on the clock (UTC), back to back.
// cutoff: sales stop this long before expiry. window: settlement averages the price over this final stretch.

export type Tenor = "1m" | "5m" | "15m" | "1h";

export const TENORS: Record<Tenor, { ms: number; cutoff: number; window: number; label: string }> = {
  "1m": { ms: 60_000, cutoff: 15_000, window: 5_000, label: "1m" },
  "5m": { ms: 300_000, cutoff: 30_000, window: 15_000, label: "5m" },
  "15m": { ms: 900_000, cutoff: 60_000, window: 30_000, label: "15m" },
  "1h": { ms: 3_600_000, cutoff: 600_000, window: 300_000, label: "1h" },
};
export const TENOR_LIST: Tenor[] = ["1m", "5m", "15m", "1h"];

// Next expiry that still has sales open.
export function nextExpiry(tenor: Tenor, now: number): number {
  const { ms, cutoff } = TENORS[tenor];
  let t = Math.ceil((now + 1) / ms) * ms;
  while (t - cutoff <= now) t += ms;
  return t;
}

// Share of the current round that has elapsed, 0..1 (for the progress bar).
export function roundProgress(tenor: Tenor, expiry: number, now: number): number {
  const { ms, cutoff } = TENORS[tenor];
  const start = expiry - ms - cutoff;
  return Math.min(1, Math.max(0, (now - start) / (ms)));
}

export function formatCountdown(ms: number): string {
  if (ms <= 0) return "0:00";
  const s = Math.floor(ms / 1000);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  const pad = (n: number) => String(n).padStart(2, "0");
  return h > 0 ? `${h}:${pad(m)}:${pad(sec)}` : `${m}:${pad(sec)}`;
}

export function formatClock(t: number, seconds = true): string {
  return new Date(t).toLocaleTimeString(undefined, {
    hour: "numeric",
    minute: "2-digit",
    ...(seconds ? { second: "2-digit" } : {}),
  });
}

// Positions can be closed (sold back to the pool) until the round's settlement window starts: prices inside the
// window are nearly final, so a close there would pick off a stale bid.
export function closeDeadline(expiry: number, tenor: Tenor): number {
  return expiry - TENORS[tenor].window;
}
export const canClose = (expiry: number, tenor: Tenor, now: number) => now < closeDeadline(expiry, tenor);

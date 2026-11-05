// Expiry schedule: hourly at the top of each UTC hour, daily at 08:00 UTC.

export type Tenor = "1h" | "1d";

export const SALES_STOP_MS: Record<Tenor, number> = {
  "1h": 10 * 60_000,
  "1d": 60 * 60_000,
};

const HOUR = 60 * 60_000;
const DAY = 24 * HOUR;

// Next tradable expiry: the first one whose sales cutoff is still ahead.
export function nextExpiry(tenor: Tenor, now: number): number {
  if (tenor === "1h") {
    let t = Math.ceil((now + 1) / HOUR) * HOUR;
    while (t - SALES_STOP_MS["1h"] <= now) t += HOUR;
    return t;
  }
  const d = new Date(now);
  let t = Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate(), 8, 0, 0);
  while (t - SALES_STOP_MS["1d"] <= now) t += DAY;
  return t;
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

export function formatExpiry(t: number): string {
  return new Date(t).toLocaleString(undefined, {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
}

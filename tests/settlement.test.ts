// The settlement-price rule shared by the edge function and the app.
import { describe, expect, it } from "vitest";
import { averageMinutes, averageSeconds } from "../supabase/functions/_shared/settlement";

describe("averageSeconds", () => {
  const to = 1_000_000_000;
  const from = to - 5_000;
  it("averages the closes inside (from, to] and reports coverage", () => {
    const pts = [0, 1, 2, 3, 4, 5].map((i) => ({ t: from + i * 1000, p: 100 + i }));
    // t = from is outside the window; from+1s .. from+5s are inside.
    expect(averageSeconds(pts, from, to)).toEqual({ price: 103, coverage: 1 });
  });
  it("reports partial coverage", () => {
    const pts = [{ t: from + 1000, p: 100 }, { t: from + 2000, p: 102 }];
    expect(averageSeconds(pts, from, to)).toEqual({ price: 101, coverage: 0.4 });
  });
  it("returns null with no data", () => {
    expect(averageSeconds([], from, to)).toEqual({ price: null, coverage: 0 });
  });
});

describe("averageMinutes (Coinbase fallback)", () => {
  const to = 1_800_000_000_000; // on a minute boundary
  const rows = [0, 1, 2, 3, 4, 5, 6].map((i) => [(to - (i + 1) * 60_000) / 1000, 0, 0, 0, 100 + i, 0]); // newest first
  it("averages minute closes for windows of a minute or more", () => {
    expect(averageMinutes(rows, to - 300_000, to)).toBe((100 + 101 + 102 + 103 + 104) / 5);
  });
  it("uses the close of the minute ending at expiry for short windows", () => {
    expect(averageMinutes(rows, to - 5_000, to)).toBe(100);
    expect(averageMinutes([...rows].reverse(), to - 5_000, to)).toBe(100);
  });
});

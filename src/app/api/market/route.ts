// GET /api/market — the server's pricing vol per asset (same value /api/buy prices with), so the ticket the
// buyer sees and the server's quote use one sigma. Cached ~30s server-side.
import { NextResponse } from "next/server";
import { serverVol } from "@/lib/server/market";

export const dynamic = "force-dynamic";

export async function GET() {
  const [BTC, ETH] = await Promise.all([serverVol("BTC"), serverVol("ETH")]);
  return NextResponse.json({ BTC, ETH }, { headers: { "Cache-Control": "no-store" } });
}

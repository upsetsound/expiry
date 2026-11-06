// GET /api/card/trade/<positionId>?tz=<IANA zone>&bg=<purple|photoId> — the trade share card as a PNG.
import { ImageResponse } from "next/og";
import ShareCard, { CARD_H, CARD_W } from "@/app/ShareCard";
import { cardFonts, safeTz, tradeCard } from "@/lib/server/card";

export async function GET(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const url = new URL(request.url);
  const r = await tradeCard((await params).id, safeTz(url.searchParams.get("tz")), url.searchParams.get("bg"));
  if (!r) return new Response("Not found", { status: 404 });
  return new ImageResponse(<ShareCard d={r.card} />, { width: CARD_W, height: CARD_H, fonts: await cardFonts(), headers: { "Cache-Control": "public, max-age=300" } });
}

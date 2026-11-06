// GET /api/card/day/<handle>/<YYYY-MM-DD>?tz=<IANA zone>&bg=<purple|photoId> — the day share card as a PNG.
import { ImageResponse } from "next/og";
import ShareCard, { CARD_H, CARD_W } from "@/app/ShareCard";
import { cardFonts, dayCard, safeTz } from "@/lib/server/card";

export async function GET(request: Request, { params }: { params: Promise<{ handle: string; date: string }> }) {
  const url = new URL(request.url);
  const { handle, date } = await params;
  const card = await dayCard(decodeURIComponent(handle), date, safeTz(url.searchParams.get("tz")), url.searchParams.get("bg"));
  if (!card) return new Response("Not found", { status: 404 });
  return new ImageResponse(<ShareCard d={card} />, { width: CARD_W, height: CARD_H, fonts: await cardFonts(), headers: { "Cache-Control": "public, max-age=300" } });
}

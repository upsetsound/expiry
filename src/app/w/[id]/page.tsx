// Public page for one settled or closed trade, linked from "Share on X". Its OG image is the share card with the
// sharer's background (?bg=) and time zone (?tz=).
import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { safeTz, tradeCard } from "@/lib/server/card";
import { TAGLINE } from "@/lib/site";

type Props = { params: Promise<{ id: string }>; searchParams: Promise<{ tz?: string; bg?: string }> };
const imageUrl = (id: string, sp: { tz?: string; bg?: string }) =>
  `/api/card/trade/${id}?tz=${encodeURIComponent(safeTz(sp.tz))}&bg=${encodeURIComponent(sp.bg ?? "purple")}`;

export async function generateMetadata({ params, searchParams }: Props): Promise<Metadata> {
  const [{ id }, sp] = await Promise.all([params, searchParams]);
  const r = await tradeCard(id, safeTz(sp.tz));
  if (!r) return { title: "Expiry" };
  const title = `${r.card.pnl} · ${r.card.pill?.text ?? ""} on Expiry`;
  const images = [{ url: imageUrl(id, sp), width: 1200, height: 670 }];
  return { title, description: TAGLINE, openGraph: { title, description: TAGLINE, images }, twitter: { card: "summary_large_image", title, description: TAGLINE, images } };
}

export default async function TradePage({ params, searchParams }: Props) {
  const [{ id }, sp] = await Promise.all([params, searchParams]);
  if (!(await tradeCard(id, safeTz(sp.tz)))) notFound();
  return (
    <main className="win-page">
      {/* eslint-disable-next-line @next/next/no-img-element */}
      <img className="card-img" src={imageUrl(id, sp)} width={1200} height={670} alt="Trade result card" />
      <Link href="/" className="buy call card-trade">
        Trade on Expiry
      </Link>
      <p className="muted small">{TAGLINE} · paper money</p>
    </main>
  );
}

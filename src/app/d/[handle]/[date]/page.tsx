// Public page for a trader's day (Day P/L card), linked from "Share my day".
import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { dayCard, safeTz } from "@/lib/server/card";
import { TAGLINE } from "@/lib/site";

type Props = { params: Promise<{ handle: string; date: string }>; searchParams: Promise<{ tz?: string; bg?: string }> };
const imageUrl = (handle: string, date: string, sp: { tz?: string; bg?: string }) =>
  `/api/card/day/${encodeURIComponent(handle)}/${date}?tz=${encodeURIComponent(safeTz(sp.tz))}&bg=${encodeURIComponent(sp.bg ?? "purple")}`;

export async function generateMetadata({ params, searchParams }: Props): Promise<Metadata> {
  const [{ handle, date }, sp] = await Promise.all([params, searchParams]);
  const card = await dayCard(decodeURIComponent(handle), date, safeTz(sp.tz));
  if (!card) return { title: "Expiry" };
  const title = `@${card.handle}'s day: ${card.pnl} on Expiry`;
  const images = [{ url: imageUrl(handle, date, sp), width: 1200, height: 670 }];
  return { title, description: TAGLINE, openGraph: { title, description: TAGLINE, images }, twitter: { card: "summary_large_image", title, description: TAGLINE, images } };
}

export default async function DayPage({ params, searchParams }: Props) {
  const [{ handle, date }, sp] = await Promise.all([params, searchParams]);
  if (!(await dayCard(decodeURIComponent(handle), date, safeTz(sp.tz)))) notFound();
  return (
    <main className="win-page">
      {/* eslint-disable-next-line @next/next/no-img-element */}
      <img className="card-img" src={imageUrl(handle, date, sp)} width={1200} height={670} alt="Day result card" />
      <Link href="/" className="buy call card-trade">
        Trade on Expiry
      </Link>
      <p className="muted small">{TAGLINE} · paper money</p>
    </main>
  );
}

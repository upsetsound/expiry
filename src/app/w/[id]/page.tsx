// Public page for one win, linked from "Share on X". The OG image next to this file makes the post show the win.
import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { getWin, winDetail, winHeadline } from "@/lib/server/win";
import { TAGLINE } from "@/lib/site";

type Props = { params: Promise<{ id: string }> };

export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const w = await getWin((await params).id);
  if (!w) return { title: "Expiry" };
  const title = `${winHeadline(w)} on a ${winDetail(w)}`;
  return { title: `${title} · Expiry`, description: TAGLINE, openGraph: { title, description: TAGLINE }, twitter: { card: "summary_large_image", title, description: TAGLINE } };
}

export default async function WinPage({ params }: Props) {
  const w = await getWin((await params).id);
  if (!w) notFound();
  const dec = w.asset === "BTC" ? 0 : 2;
  return (
    <main className="win-page">
      <div className="wincard static">
        <div className="win-pnl">+{w.payout.toLocaleString("en-US", { style: "currency", currency: "USD" })}</div>
        <div className="win-mult">{w.multiple < 10 ? w.multiple.toFixed(1) : Math.round(w.multiple)}×</div>
        <div className="win-meta">
          <span>{winDetail(w)}</span>
          <span>
            {w.asset} {w.strike.toLocaleString("en-US", { maximumFractionDigits: 1 })} {w.side} · settled at{" "}
            {w.settle.toLocaleString("en-US", { minimumFractionDigits: dec, maximumFractionDigits: dec })}
          </span>
        </div>
        <div className="win-actions">
          <Link href="/" className="win-share">
            Trade
          </Link>
        </div>
      </div>
      <p className="muted small">{TAGLINE} · paper money</p>
    </main>
  );
}

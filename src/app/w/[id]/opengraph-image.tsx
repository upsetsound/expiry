// Share image for one win: "+$84.20 · 8.4×", the option and the trader.
import { ImageResponse } from "next/og";
import { Logo, OG, OG_SIZE, StepLine } from "../../og";
import { getWin } from "@/lib/server/win";
import { TAGLINE } from "@/lib/site";

export const alt = "A winning trade on Expiry";
export const size = OG_SIZE;
export const contentType = "image/png";

export default async function Image({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const w = await getWin(id);
  const mult = w ? `${w.multiple < 10 ? w.multiple.toFixed(1) : Math.round(w.multiple)}×` : "";
  return new ImageResponse(
    (
      <div style={{ width: "100%", height: "100%", display: "flex", flexDirection: "column", justifyContent: "space-between", padding: "64px 88px", background: OG.bg, position: "relative" }}>
        <StepLine opacity={0.18} />
        <Logo size={56} />
        {w ? (
          <div style={{ display: "flex", flexDirection: "column" }}>
            <div style={{ display: "flex", alignItems: "baseline", gap: 32 }}>
              <div style={{ fontSize: 150, fontWeight: 700, letterSpacing: "-0.04em", color: OG.mint, lineHeight: 1 }}>
                {`+${w.payout.toLocaleString("en-US", { style: "currency", currency: "USD" })}`}
              </div>
              <div style={{ fontSize: 84, fontWeight: 600, color: OG.text }}>{mult}</div>
            </div>
            <div style={{ marginTop: 24, fontSize: 40, color: OG.text }}>
              {`${w.tenor} ${w.asset} ${w.side}${w.handle ? `  ·  @${w.handle}` : ""}`}
            </div>
          </div>
        ) : (
          <div style={{ fontSize: 60, fontWeight: 600, color: OG.text }}>{TAGLINE}</div>
        )}
        <div style={{ fontSize: 28, color: OG.muted }}>{TAGLINE}</div>
      </div>
    ),
    size,
  );
}

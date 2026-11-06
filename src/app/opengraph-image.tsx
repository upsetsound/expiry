// Site-wide share image: logo + tagline on the dark/mint background. Rendered once at build (static).
import { ImageResponse } from "next/og";
import { Logo, OG, OG_SIZE, StepLine } from "./og";
import { TAGLINE } from "@/lib/site";

export const alt = `Expiry: ${TAGLINE}`;
export const size = OG_SIZE;
export const contentType = "image/png";

export default function Image() {
  return new ImageResponse(
    (
      <div style={{ width: "100%", height: "100%", display: "flex", flexDirection: "column", justifyContent: "center", padding: "0 96px", background: OG.bg, position: "relative" }}>
        <StepLine opacity={0.22} />
        <Logo size={88} />
        <div style={{ marginTop: 36, fontSize: 60, fontWeight: 600, letterSpacing: "-0.03em", color: OG.text, maxWidth: 900, lineHeight: 1.1 }}>{TAGLINE}</div>
        <div style={{ marginTop: 24, fontSize: 30, color: OG.muted }}>Pick your multiple. Paper money. Weekly leaderboard.</div>
      </div>
    ),
    size,
  );
}

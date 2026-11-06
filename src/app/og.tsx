// Shared pieces for the Open Graph images (next/og). Dark/mint, matching the app.
export const OG_SIZE = { width: 1200, height: 630 };
export const OG = { bg: "#0B1513", panel: "#0E1A18", text: "#EAF4F1", muted: "#7F9792", mint: "#8FF5D2", line: "rgba(234,244,241,0.10)" };

export function Logo({ size = 56 }: { size?: number }) {
  return (
    <div style={{ display: "flex", alignItems: "center", gap: size * 0.3 }}>
      <svg width={size} height={size} viewBox="0 0 100 100">
        <path d="M50 50 L50 12 A38 38 0 1 0 88 50 Z" fill={OG.mint} stroke={OG.mint} strokeWidth={6} strokeLinejoin="round" />
      </svg>
      <div style={{ fontSize: size * 0.95, fontWeight: 600, letterSpacing: "-0.045em", color: OG.text }}>expiry</div>
    </div>
  );
}

// A stylised step line, like the live chart, for the background.
export function StepLine({ color = OG.mint, opacity = 0.35 }: { color?: string; opacity?: number }) {
  const pts = [470, 470, 440, 455, 410, 420, 380, 395, 340, 360, 300, 320, 270, 230, 250, 200, 215, 170];
  const w = 1200 / (pts.length - 1);
  const d = pts.map((y, i) => `${i ? "H" : "M0 "}${i ? Math.round(i * w) : y} ${i ? `V${y}` : ""}`).join(" ");
  return (
    <svg width="1200" height="630" viewBox="0 0 1200 630" style={{ position: "absolute", left: 0, top: 0 }}>
      <path d={d} fill="none" stroke={color} strokeOpacity={opacity} strokeWidth={4} />
    </svg>
  );
}

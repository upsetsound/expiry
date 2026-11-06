// The P/L share card, 1200x670. Inline styles and flex only, so the same component renders in next/og
// (the /api/card images) and in the browser (the in-app win card, scaled).

export const CARD_W = 1200;
export const CARD_H = 670;
const PURPLE = "#9430E8";
const BOX = "rgba(110,120,230,.55)";

export type CardData = {
  date: string; // "Thursday, Nov 5, 2026"
  subline: string; // "1m BTC Call · strike 76,230 · settled 6:04 PM"
  pnl: string; // "+$84.20"
  profit: boolean;
  pill: { coin: "₿" | "Ξ" | null; text: string } | null; // "8.4×" or "+3.2%"
  handle: string | null;
  isX?: boolean; // false for a Google username (shown without "@")
  avatar: string | null;
  site: string;
  photo: string | null; // background photo URL, or null for purple
};

function Mark({ size }: { size: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 100 100">
      <path d="M50 50 L50 12 A38 38 0 1 0 88 50 Z" fill="#fff" stroke="#fff" strokeWidth={6} strokeLinejoin="round" />
    </svg>
  );
}

export default function ShareCard({ d }: { d: CardData }) {
  const shadow = d.photo ? "0 2px 10px rgba(0,0,0,.45)" : "none";
  return (
    <div
      style={{
        width: CARD_W,
        height: CARD_H,
        display: "flex",
        position: "relative",
        overflow: "hidden",
        background: PURPLE,
        color: "#fff",
        fontFamily: "Inter Display",
      }}
    >
      {d.photo && (
        // eslint-disable-next-line @next/next/no-img-element
        <img src={d.photo} width={CARD_W} height={CARD_H} alt="" style={{ position: "absolute", left: 0, top: 0, width: CARD_W, height: CARD_H, objectFit: "cover" }} />
      )}
      {d.photo && (
        <div style={{ position: "absolute", left: 0, top: 0, width: CARD_W, height: CARD_H, display: "flex", backgroundImage: "linear-gradient(90deg, rgba(0,0,0,.55), rgba(0,0,0,0) 70%)" }} />
      )}
      {d.photo && (
        <div style={{ position: "absolute", left: 0, top: 0, width: CARD_W, height: CARD_H, display: "flex", backgroundImage: "linear-gradient(0deg, rgba(0,0,0,.45), rgba(0,0,0,0) 38%)" }} />
      )}
      <div style={{ position: "relative", display: "flex", flexDirection: "column", width: CARD_W, height: CARD_H, padding: "52px 64px 48px" }}>
        <div style={{ display: "flex", alignItems: "center", gap: 16 }}>
          <Mark size={52} />
          <div style={{ fontSize: 56, fontWeight: 600, letterSpacing: "-0.04em", lineHeight: 1, textShadow: shadow }}>expiry</div>
        </div>

        <div style={{ display: "flex", flexDirection: "column", marginTop: "auto" }}>
          <div style={{ fontSize: 38, fontWeight: 600, letterSpacing: "-0.01em", textShadow: shadow }}>{d.date}</div>
          <div style={{ fontSize: 22, fontWeight: 500, opacity: 0.8, marginTop: 6, maxWidth: 1060, textShadow: shadow }}>{d.subline}</div>
          <div style={{ display: "flex", marginTop: 22 }}>
            <div
              style={{
                display: "flex",
                background: BOX,
                borderRadius: 14,
                padding: "4px 22px 8px",
                fontSize: 84,
                fontWeight: 700,
                letterSpacing: "-0.03em",
                lineHeight: 1.1,
                color: d.profit ? "#8FF5D2" : "#FFA394",
              }}
            >
              {d.pnl}
            </div>
          </div>
          {d.pill && (
            <div style={{ display: "flex", marginTop: 12 }}>
              <div style={{ display: "flex", alignItems: "center", gap: 12, background: BOX, borderRadius: 14, padding: d.pill.coin ? "8px 18px 8px 10px" : "8px 18px", fontSize: 30, fontWeight: 600 }}>
                {d.pill.coin && (
                  <div style={{ display: "flex", alignItems: "center", justifyContent: "center", width: 38, height: 38, borderRadius: 19, background: "#fff", color: PURPLE, fontSize: 24, fontWeight: 700 }}>
                    {d.pill.coin}
                  </div>
                )}
                <div style={{ display: "flex" }}>{d.pill.text}</div>
              </div>
            </div>
          )}
        </div>

        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginTop: 34 }}>
          <div style={{ display: "flex", alignItems: "center", gap: 16, maxWidth: 720 }}>
            {d.avatar ? (
              // eslint-disable-next-line @next/next/no-img-element
              <img src={d.avatar} width={56} height={56} alt="" style={{ width: 56, height: 56, borderRadius: 28, border: "2px solid rgba(255,255,255,.7)" }} />
            ) : (
              <div style={{ display: "flex", width: 56, height: 56, borderRadius: 28, background: BOX }} />
            )}
            <div style={{ display: "flex", fontSize: 28, fontWeight: 600, maxWidth: 640, overflow: "hidden", whiteSpace: "nowrap", textOverflow: "ellipsis", textShadow: shadow }}>
              {d.handle ? (d.isX === false ? d.handle : "@" + d.handle) : "expiry trader"}
            </div>
          </div>
          <div style={{ display: "flex", flexDirection: "column", alignItems: "flex-end", textShadow: shadow }}>
            <div style={{ fontSize: 20, fontWeight: 600, letterSpacing: "0.28em" }}>PAPER</div>
            <div style={{ fontSize: 22, fontWeight: 500, opacity: 0.85, marginTop: 4 }}>{d.site}</div>
          </div>
        </div>
      </div>
    </div>
  );
}

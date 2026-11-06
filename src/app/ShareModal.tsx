"use client";
// Share window: pick a background (Purple, an earlier photo, or upload + crop), see the exact card the server
// renders, then Share on X / Download PNG / Copy link. Live mode only (cards are rendered from server data).
import { useEffect, useRef, useState } from "react";

export type ShareTarget = { kind: "trade"; id: string; text: string } | { kind: "day"; handle: string; date: string; text: string };
type Photo = { id: string; url: string | null };

const W = 1200;
const H = 670;
const MAX_BYTES = 5 * 1024 * 1024;

export default function ShareModal({ target, onClose }: { target: ShareTarget; onClose: () => void }) {
  const tz = typeof Intl !== "undefined" ? Intl.DateTimeFormat().resolvedOptions().timeZone : "UTC";
  const [bg, setBg] = useState("purple");
  const [photos, setPhotos] = useState<Photo[]>([]);
  const [crop, setCrop] = useState<{ src: string; img: HTMLImageElement; x: number; y: number } | null>(null);
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<string | null>(null);
  const drag = useRef<{ x: number; y: number; cx: number; cy: number } | null>(null);

  const loadPhotos = () =>
    fetch("/api/card-bg")
      .then((r) => (r.ok ? r.json() : null))
      .then((j) => {
        if (!j) return;
        setPhotos(j.photos ?? []);
        if (j.last && (j.last === "purple" || (j.photos ?? []).some((p: Photo) => p.id === j.last))) setBg(j.last);
      })
      .catch(() => {});
  useEffect(() => {
    loadPhotos();
  }, []);

  const q = `tz=${encodeURIComponent(tz)}&bg=${encodeURIComponent(bg)}`;
  const image = target.kind === "trade" ? `/api/card/trade/${target.id}?${q}` : `/api/card/day/${encodeURIComponent(target.handle)}/${target.date}?${q}`;
  const page = target.kind === "trade" ? `/w/${target.id}?${q}` : `/d/${encodeURIComponent(target.handle)}/${target.date}?${q}`;
  const link = `${window.location.origin}${page}`;

  const choose = (id: string) => {
    setBg(id);
    fetch("/api/card-bg", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ use: id }) }).catch(() => {});
  };

  const pick = (file: File | undefined) => {
    setNote(null);
    if (!file) return;
    if (!["image/jpeg", "image/png", "image/webp"].includes(file.type)) return setNote("Upload a JPG, PNG or WebP");
    if (file.size > MAX_BYTES) return setNote("Photos up to 5 MB");
    const src = URL.createObjectURL(file);
    const img = new Image();
    img.onload = () => setCrop({ src, img, x: 50, y: 50 });
    img.src = src;
  };

  // Draw the chosen 1200x670 window of the photo (cover-scaled, positioned by x/y %) and upload it as a JPEG.
  // Re-encoding through a canvas drops all the original file's metadata (location, camera, etc.).
  const upload = async () => {
    if (!crop) return;
    setBusy(true);
    const { img, x, y } = crop;
    const scale = Math.max(W / img.naturalWidth, H / img.naturalHeight);
    const sw = W / scale;
    const sh = H / scale;
    const sx = ((img.naturalWidth - sw) * x) / 100;
    const sy = ((img.naturalHeight - sh) * y) / 100;
    const canvas = document.createElement("canvas");
    canvas.width = W;
    canvas.height = H;
    canvas.getContext("2d")!.drawImage(img, sx, sy, sw, sh, 0, 0, W, H);
    const blob = await new Promise<Blob | null>((res) => canvas.toBlob(res, "image/jpeg", 0.9));
    if (!blob) return setBusy(false);
    const form = new FormData();
    form.append("file", blob, "card.jpg");
    const r = await fetch("/api/card-bg", { method: "POST", body: form }).catch(() => null);
    const j = await r?.json().catch(() => null);
    setBusy(false);
    if (!r?.ok || !j?.id) return setNote(j?.message ?? "Upload failed. Try again.");
    URL.revokeObjectURL(crop.src);
    setCrop(null);
    setBg(j.id);
    loadPhotos();
  };

  const download = async () => {
    const r = await fetch(image);
    const url = URL.createObjectURL(await r.blob());
    const a = document.createElement("a");
    a.href = url;
    a.download = target.kind === "trade" ? "expiry-trade.png" : `expiry-day-${target.date}.png`;
    a.click();
    URL.revokeObjectURL(url);
  };
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(link);
      setNote("Link copied");
    } catch {
      setNote(link);
    }
  };
  const shareX = () => window.open(`https://x.com/intent/post?text=${encodeURIComponent(`${target.text} ${link}`)}`, "_blank", "noopener,noreferrer");

  return (
    <div className="share-backdrop" onClick={onClose}>
      <div className="share-modal" role="dialog" aria-label="Share" onClick={(e) => e.stopPropagation()}>
        <div className="share-head">
          <strong>{target.kind === "trade" ? "Share trade" : "Share my day"}</strong>
          <button className="intro-x" onClick={onClose} aria-label="Close">
            ×
          </button>
        </div>

        {crop ? (
          <div className="crop">
            <div
              className="crop-frame"
              style={{ backgroundImage: `url(${crop.src})`, backgroundPosition: `${crop.x}% ${crop.y}%` }}
              onPointerDown={(e) => {
                (e.target as HTMLElement).setPointerCapture(e.pointerId);
                drag.current = { x: e.clientX, y: e.clientY, cx: crop.x, cy: crop.y };
              }}
              onPointerMove={(e) => {
                const d = drag.current;
                if (!d) return;
                const r = (e.currentTarget as HTMLElement).getBoundingClientRect();
                const clamp = (v: number) => Math.max(0, Math.min(100, v));
                setCrop((c) => (c ? { ...c, x: clamp(d.cx - ((e.clientX - d.x) / r.width) * 100), y: clamp(d.cy - ((e.clientY - d.y) / r.height) * 100) } : c));
              }}
              onPointerUp={() => (drag.current = null)}
            />
            <p className="muted small">Drag to position.</p>
            <div className="share-actions">
              <button className="win-again" onClick={() => setCrop(null)}>
                Cancel
              </button>
              <button className="win-share" onClick={upload} disabled={busy}>
                {busy ? "Uploading…" : "Use photo"}
              </button>
            </div>
          </div>
        ) : (
          <>
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img className="share-preview" src={image} alt="Card preview" width={W} height={H} />
            <div className="bg-picker" role="group" aria-label="Background">
              <button className={`bg-opt purple ${bg === "purple" ? "on" : ""}`} onClick={() => choose("purple")}>
                Purple
              </button>
              {photos.map((p) => (
                <button
                  key={p.id}
                  className={`bg-opt photo ${bg === p.id ? "on" : ""}`}
                  style={p.url ? { backgroundImage: `url(${p.url})` } : undefined}
                  onClick={() => choose(p.id)}
                  aria-label="Use this photo"
                />
              ))}
              <label className="bg-opt upload">
                Upload photo
                <input type="file" accept="image/jpeg,image/png,image/webp" hidden onChange={(e) => pick(e.target.files?.[0])} />
              </label>
            </div>
            <div className="share-actions">
              <button className="win-share" onClick={shareX}>
                Share on X
              </button>
              <button className="win-again" onClick={download}>
                Download PNG
              </button>
              <button className="win-again" onClick={copy}>
                Copy link
              </button>
            </div>
          </>
        )}
        {note && <p className="small share-note">{note}</p>}
      </div>
    </div>
  );
}

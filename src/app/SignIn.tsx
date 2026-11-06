"use client";
// Sign-in choice (X or Google), and the one-time username step for Google players (Google gives a real name,
// which we never show; X players use their handle).
import { useState } from "react";
import type { Provider } from "@/lib/account";

export function SignInModal({ onPick, onClose }: { onPick: (p: Provider) => void; onClose: () => void }) {
  return (
    <div className="share-backdrop" onClick={onClose}>
      <div className="share-modal signin-modal" role="dialog" aria-label="Sign in" onClick={(e) => e.stopPropagation()}>
        <div className="share-head">
          <strong>Sign in to trade</strong>
          <button className="intro-x" onClick={onClose} aria-label="Close">
            ×
          </button>
        </div>
        <p className="muted small">Paper money. Everyone starts with $10,000.</p>
        <div className="signin-options">
          <button className="win-share" onClick={() => onPick("x")}>
            Continue with X
          </button>
          <button className="win-again" onClick={() => onPick("google")}>
            Continue with Google
          </button>
        </div>
      </div>
    </div>
  );
}

export function UsernameModal({ onSave, onClose }: { onSave: (name: string) => Promise<{ ok: boolean; message?: string }>; onClose: () => void }) {
  const [name, setName] = useState("");
  const [note, setNote] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const valid = /^[A-Za-z0-9_]{3,15}$/.test(name);
  const save = async () => {
    if (!valid || busy) return;
    setBusy(true);
    const r = await onSave(name);
    setBusy(false);
    if (!r.ok) setNote(r.message ?? "Couldn't save. Try again.");
  };
  return (
    <div className="share-backdrop" onClick={onClose}>
      <div className="share-modal signin-modal" role="dialog" aria-label="Pick a username" onClick={(e) => e.stopPropagation()}>
        <div className="share-head">
          <strong>Pick a username</strong>
          <button className="intro-x" onClick={onClose} aria-label="Close">
            ×
          </button>
        </div>
        <p className="muted small">This is how you show up on the leaderboard and live trades. You can&apos;t change it later.</p>
        <form
          className="username-form"
          onSubmit={(e) => {
            e.preventDefault();
            save();
          }}
        >
          <input
            className="username-input"
            value={name}
            onChange={(e) => {
              setName(e.target.value.replace(/\s/g, "").slice(0, 15));
              setNote(null);
            }}
            placeholder="moon_trader"
            autoFocus
            autoComplete="off"
            spellCheck={false}
            aria-label="Username"
          />
          <button className="win-share" type="submit" disabled={!valid || busy}>
            {busy ? "Saving…" : "Save"}
          </button>
        </form>
        <p className="small share-note">{note ?? "3–15 letters, numbers or _"}</p>
      </div>
    </div>
  );
}

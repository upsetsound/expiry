"use client";
// Non-blocking nudge for guests to save their account with X (links X to the same account: balance and history
// carry over). Floating card for moments (first settled trade, Share); inline strip on the leaderboard.
export default function SavePrompt({ text, onSave, onClose, inline }: { text: string; onSave: () => void; onClose?: () => void; inline?: boolean }) {
  return (
    <div className={inline ? "save-prompt inline" : "save-prompt"} role="status">
      <span>{text}</span>
      <button className="signin" onClick={onSave}>
        Sign in with X
      </button>
      {onClose && (
        <button className="intro-x" onClick={onClose} aria-label="Dismiss">
          ×
        </button>
      )}
    </div>
  );
}

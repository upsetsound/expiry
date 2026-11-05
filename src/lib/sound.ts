"use client";
// Generated sounds (Web Audio, no files): click on buy, rising chime on a win, low blip on a loss, ticks in the
// final seconds. Browsers only allow audio after a user gesture, so the AudioContext is created on the first
// pointer or key press; sounds requested before that are skipped. Mute is saved in localStorage (default on).
import { useCallback, useEffect, useState } from "react";

const KEY = "expiry.sound";
let ctx: AudioContext | null = null;
let muted = false;
let armed = false;
const listeners = new Set<(m: boolean) => void>();

function readMuted(): boolean {
  try {
    return localStorage.getItem(KEY) === "off";
  } catch {
    return false;
  }
}

function arm() {
  if (armed || typeof window === "undefined") return;
  armed = true;
  muted = readMuted();
  const unlock = () => {
    try {
      const AC = window.AudioContext ?? (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
      ctx ??= new AC();
      if (ctx.state === "suspended") ctx.resume();
    } catch {
      ctx = null;
    }
  };
  window.addEventListener("pointerdown", unlock, { capture: true });
  window.addEventListener("keydown", unlock, { capture: true });
}

// One enveloped oscillator note. `at` is seconds from now.
function note(freq: number, at: number, dur: number, peak: number, type: OscillatorType = "sine", glideTo?: number) {
  if (!ctx || muted || ctx.state !== "running") return;
  const t = ctx.currentTime + at;
  const osc = ctx.createOscillator();
  const gain = ctx.createGain();
  const filter = ctx.createBiquadFilter();
  filter.type = "lowpass";
  filter.frequency.value = Math.max(1200, freq * 3);
  osc.type = type;
  osc.frequency.setValueAtTime(freq, t);
  if (glideTo) osc.frequency.exponentialRampToValueAtTime(glideTo, t + dur);
  gain.gain.setValueAtTime(0.0001, t);
  gain.gain.exponentialRampToValueAtTime(peak, t + Math.min(0.012, dur / 4));
  gain.gain.exponentialRampToValueAtTime(0.0001, t + dur);
  osc.connect(filter).connect(gain).connect(ctx.destination);
  osc.start(t);
  osc.stop(t + dur + 0.02);
}

export const sounds = {
  click: () => note(1400, 0, 0.045, 0.05, "triangle", 900),
  win: () => {
    note(659.25, 0, 0.16, 0.11, "triangle"); // E5
    note(987.77, 0.1, 0.32, 0.11, "triangle"); // B5
  },
  loss: () => note(185, 0, 0.22, 0.09, "sine", 120),
  tick: () => note(2000, 0, 0.025, 0.025, "sine"),
};

export function setMuted(m: boolean) {
  muted = m;
  try {
    localStorage.setItem(KEY, m ? "off" : "on");
  } catch {}
  listeners.forEach((l) => l(m));
}

// Arms audio on mount and exposes the mute toggle.
export function useSound() {
  const [m, setM] = useState(false);
  useEffect(() => {
    arm();
    setM(muted);
    listeners.add(setM);
    return () => {
      listeners.delete(setM);
    };
  }, []);
  const toggle = useCallback(() => setMuted(!muted), []);
  return { muted: m, toggle };
}

"use client";

import { createContext, useSyncExternalStore } from "react";

export const CHAT_ANIMATION_DURATION_MIN_MS = 400;
export const CHAT_ANIMATION_DURATION_MAX_MS = 2000;
const CHAT_ANIMATION_DURATION_DEFAULT_MS = 800;

const storageKey = "omp-chat-animations";
const durationKey = "omp-chat-animation-duration";
const changeEvent = "omp-chat-animations-changed";

/** Duration in milliseconds, or zero when chat motion is disabled. */
export const ChatAnimationsContext = createContext(0);

function readPreference(): boolean {
  try { return window.localStorage.getItem(storageKey) !== "off"; }
  catch { return true; }
}

function readDuration(): number {
  try {
    const stored = window.localStorage.getItem(durationKey);
    if (stored !== null) {
      const duration = Number(stored);
      if (Number.isInteger(duration) && duration >= CHAT_ANIMATION_DURATION_MIN_MS && duration <= CHAT_ANIMATION_DURATION_MAX_MS) {
        return duration;
      }
    }
  } catch {
    // Browser storage is optional.
  }
  return CHAT_ANIMATION_DURATION_DEFAULT_MS;
}

function subscribe(listener: () => void): () => void {
  const onStorage = (event: StorageEvent) => {
    if (event.key === storageKey || event.key === durationKey || event.key === null) listener();
  };
  window.addEventListener(changeEvent, listener);
  window.addEventListener("storage", onStorage);
  return () => {
    window.removeEventListener(changeEvent, listener);
    window.removeEventListener("storage", onStorage);
  };
}

function savePreference(key: string, value: string): void {
  try { window.localStorage.setItem(key, value); }
  catch { return; }
  window.dispatchEvent(new Event(changeEvent));
}

export function setChatAnimations(enabled: boolean): void {
  savePreference(storageKey, enabled ? "on" : "off");
}

export function setChatAnimationDuration(duration: number): void {
  savePreference(durationKey, String(duration));
}

export function useChatAnimationDuration(): number {
  return useSyncExternalStore(subscribe, readDuration, () => CHAT_ANIMATION_DURATION_DEFAULT_MS);
}

export function useChatAnimationsPreference(): boolean {
  return useSyncExternalStore(subscribe, readPreference, () => true);
}

let reducedMotion: MediaQueryList | undefined;
const motionQuery = () => reducedMotion ??= window.matchMedia("(prefers-reduced-motion: reduce)");

function subscribeToEffectiveMotion(listener: () => void): () => void {
  const unsubscribe = subscribe(listener);
  const media = motionQuery();
  media.addEventListener("change", listener);
  return () => {
    unsubscribe();
    media.removeEventListener("change", listener);
  };
}

export function useEffectiveChatAnimationDuration(): number {
  return useSyncExternalStore(subscribeToEffectiveMotion, () => readPreference() && !motionQuery().matches ? readDuration() : 0, () => 0);
}

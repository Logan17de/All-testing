"use client";

import { useSyncExternalStore } from "react";

export const CHAT_PREFERENCES_KEY = "zet.chat.preferences.v1";
const preferencesChanged = "zet:chat-preferences-changed";
export const CHAT_TOOL_OPTIONS = [
  "mutationConsent",
  "subagentsEnabled",
  "searchEnabled",
  "browserEnabled",
  "desktopEnabled",
] as const;
export type ChatToolOption = (typeof CHAT_TOOL_OPTIONS)[number];
export type ChatPreferences = Readonly<{ instructions: string } & Record<ChatToolOption, boolean>>;
export const DEFAULT_CHAT_PREFERENCES: ChatPreferences = Object.freeze({
  instructions: "",
  mutationConsent: true,
  subagentsEnabled: true,
  searchEnabled: true,
  browserEnabled: true,
  desktopEnabled: true,
});

export function parseChatPreferences(raw: string | null): ChatPreferences {
  if (!raw) return DEFAULT_CHAT_PREFERENCES;
  try {
    const value: unknown = JSON.parse(raw);
    if (!value || typeof value !== "object" || Array.isArray(value))
      return DEFAULT_CHAT_PREFERENCES;
    const saved = value as Record<string, unknown>;
    return Object.freeze({
      instructions: typeof saved.instructions === "string" ? saved.instructions : "",
      mutationConsent: typeof saved.mutationConsent === "boolean" ? saved.mutationConsent : true,
      subagentsEnabled: typeof saved.subagentsEnabled === "boolean" ? saved.subagentsEnabled : true,
      searchEnabled: typeof saved.searchEnabled === "boolean" ? saved.searchEnabled : true,
      browserEnabled: typeof saved.browserEnabled === "boolean" ? saved.browserEnabled : true,
      desktopEnabled: typeof saved.desktopEnabled === "boolean" ? saved.desktopEnabled : true,
    });
  } catch {
    return DEFAULT_CHAT_PREFERENCES;
  }
}

// Keep snapshots stable between reads, including when browser storage is unavailable.
let cachedRaw: string | null | undefined;
let cachedPreferences = DEFAULT_CHAT_PREFERENCES;
export function readChatPreferences(): ChatPreferences {
  if (typeof window === "undefined") return DEFAULT_CHAT_PREFERENCES;
  try {
    const raw = window.localStorage.getItem(CHAT_PREFERENCES_KEY);
    if (raw !== cachedRaw) {
      cachedRaw = raw;
      cachedPreferences = parseChatPreferences(raw);
    }
  } catch {
    // The current page can still use preferences if storage is blocked or full.
  }
  return cachedPreferences;
}

export function subscribeChatPreferences(onChange: () => void): () => void {
  const onStorage = (event: StorageEvent) => {
    if (event.key === CHAT_PREFERENCES_KEY || event.key === null) onChange();
  };
  window.addEventListener(preferencesChanged, onChange);
  window.addEventListener("storage", onStorage);
  return () => {
    window.removeEventListener(preferencesChanged, onChange);
    window.removeEventListener("storage", onStorage);
  };
}

export function updateChatPreferences(change: Partial<ChatPreferences>): boolean {
  if (typeof window === "undefined") return false;
  const next = parseChatPreferences(JSON.stringify({ ...readChatPreferences(), ...change }));
  const raw = JSON.stringify(next);
  let persisted = false;
  try {
    window.localStorage.setItem(CHAT_PREFERENCES_KEY, raw);
    cachedRaw = raw;
    persisted = true;
  } catch {
    // Retain the choices in memory and tell the caller persistence was unavailable.
  }
  cachedPreferences = next;
  window.dispatchEvent(new Event(preferencesChanged));
  return persisted;
}

export function useChatPreferences(): ChatPreferences {
  return useSyncExternalStore(
    subscribeChatPreferences,
    readChatPreferences,
    () => DEFAULT_CHAT_PREFERENCES,
  );
}

export function chatTaskOptions(preferences: ChatPreferences) {
  return {
    mutationConsent: preferences.mutationConsent,
    subagentsEnabled: preferences.subagentsEnabled,
    searchEnabled: preferences.searchEnabled,
    browserEnabled: preferences.browserEnabled,
    desktopEnabled: preferences.desktopEnabled,
    ...(preferences.instructions.trim() ? { instructions: preferences.instructions } : {}),
  };
}

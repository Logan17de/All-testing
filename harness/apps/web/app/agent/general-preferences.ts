"use client";

import { useEffect, useSyncExternalStore } from "react";

export const GENERAL_PREFERENCES_KEY = "zet.general.preferences.v1";
const preferencesChanged = "zet:general-preferences-changed";

export type SendShortcut = "enter" | "mod-enter";
export type TurnCompletionNotifications = "unfocused" | "always" | "never";
export type NotificationSound = "off" | "chime";
export type GeneralPreferences = Readonly<{
  sendShortcut: SendShortcut;
  confirmBeforeClose: boolean;
  openSidePanelByDefault: boolean;
  turnCompletionNotifications: TurnCompletionNotifications;
  permissionNotifications: boolean;
  notificationSound: NotificationSound;
}>;

export const DEFAULT_GENERAL_PREFERENCES: GeneralPreferences = Object.freeze({
  sendShortcut: "enter",
  confirmBeforeClose: true,
  openSidePanelByDefault: true,
  turnCompletionNotifications: "unfocused",
  permissionNotifications: true,
  notificationSound: "off",
});

export function parseGeneralPreferences(raw: string | null): GeneralPreferences {
  if (!raw) return DEFAULT_GENERAL_PREFERENCES;
  try {
    const value: unknown = JSON.parse(raw);
    if (!value || typeof value !== "object" || Array.isArray(value))
      return DEFAULT_GENERAL_PREFERENCES;
    const saved = value as Record<string, unknown>;
    return Object.freeze({
      sendShortcut: saved.sendShortcut === "mod-enter" ? "mod-enter" : "enter",
      confirmBeforeClose:
        typeof saved.confirmBeforeClose === "boolean" ? saved.confirmBeforeClose : true,
      openSidePanelByDefault:
        typeof saved.openSidePanelByDefault === "boolean" ? saved.openSidePanelByDefault : true,
      turnCompletionNotifications:
        saved.turnCompletionNotifications === "always" ||
        saved.turnCompletionNotifications === "never"
          ? saved.turnCompletionNotifications
          : "unfocused",
      permissionNotifications:
        typeof saved.permissionNotifications === "boolean" ? saved.permissionNotifications : true,
      notificationSound: saved.notificationSound === "chime" ? "chime" : "off",
    });
  } catch {
    return DEFAULT_GENERAL_PREFERENCES;
  }
}

// React requires the same snapshot object until the stored value changes.
let cachedRaw: string | null | undefined;
let cachedPreferences = DEFAULT_GENERAL_PREFERENCES;

export function readGeneralPreferences(): GeneralPreferences {
  if (typeof window === "undefined") return DEFAULT_GENERAL_PREFERENCES;
  try {
    const raw = window.localStorage.getItem(GENERAL_PREFERENCES_KEY);
    if (raw !== cachedRaw) {
      cachedRaw = raw;
      cachedPreferences = parseGeneralPreferences(raw);
    }
  } catch {
    // Keep the current page usable when browser storage is unavailable.
  }
  return cachedPreferences;
}

export function subscribeGeneralPreferences(onChange: () => void): () => void {
  if (typeof window === "undefined") return () => {};
  const onStorage = (event: StorageEvent) => {
    if (event.key === GENERAL_PREFERENCES_KEY || event.key === null) onChange();
  };
  window.addEventListener(preferencesChanged, onChange);
  window.addEventListener("storage", onStorage);
  return () => {
    window.removeEventListener(preferencesChanged, onChange);
    window.removeEventListener("storage", onStorage);
  };
}

export function updateGeneralPreferences(change: Partial<GeneralPreferences>): boolean {
  if (typeof window === "undefined") return false;
  const next = parseGeneralPreferences(JSON.stringify({ ...readGeneralPreferences(), ...change }));
  const raw = JSON.stringify(next);
  let persisted = false;
  try {
    window.localStorage.setItem(GENERAL_PREFERENCES_KEY, raw);
    cachedRaw = raw;
    persisted = true;
  } catch {
    // The settings page can report that these choices will last for this page only.
  }
  cachedPreferences = next;
  window.dispatchEvent(new Event(preferencesChanged));
  return persisted;
}

export function useGeneralPreferences(): GeneralPreferences {
  return useSyncExternalStore(
    subscribeGeneralPreferences,
    readGeneralPreferences,
    () => DEFAULT_GENERAL_PREFERENCES,
  );
}

type ComposerKeyEvent = {
  key: string;
  shiftKey?: boolean;
  ctrlKey?: boolean;
  metaKey?: boolean;
  altKey?: boolean;
  isComposing?: boolean;
  keyCode?: number;
};

export function shouldSubmitComposer(event: ComposerKeyEvent, shortcut: SendShortcut): boolean {
  if (
    event.key !== "Enter" ||
    event.shiftKey ||
    event.altKey ||
    event.isComposing ||
    event.keyCode === 229
  )
    return false;
  return shortcut === "enter" || Boolean(event.ctrlKey || event.metaKey);
}

export function composerShortcutHint(shortcut: SendShortcut): string {
  return shortcut === "mod-enter"
    ? "Ctrl / Cmd + Enter to send. Enter for a new line."
    : "Enter to send. Shift + Enter for a new line.";
}

export function shouldConfirmBeforeClose({
  enabled,
  prompt,
  active,
}: {
  enabled: boolean;
  prompt: string;
  active: boolean;
}): boolean {
  return enabled && (Boolean(prompt.trim()) || active);
}

export function useConfirmBeforeClose(options: Parameters<typeof shouldConfirmBeforeClose>[0]) {
  const confirm = shouldConfirmBeforeClose(options);
  useEffect(() => {
    if (!confirm) return;
    const onBeforeUnload = (event: BeforeUnloadEvent) => {
      event.preventDefault();
      event.returnValue = "";
    };
    window.addEventListener("beforeunload", onBeforeUnload);
    return () => window.removeEventListener("beforeunload", onBeforeUnload);
  }, [confirm]);
}

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  DEFAULT_GENERAL_PREFERENCES,
  GENERAL_PREFERENCES_KEY,
  composerShortcutHint,
  parseGeneralPreferences,
  shouldConfirmBeforeClose,
  shouldSubmitComposer,
} from "./general-preferences";

describe("General preferences", () => {
  beforeEach(() => vi.resetModules());
  afterEach(() => vi.unstubAllGlobals());

  function browser(initial: string | null = null) {
    const target = new EventTarget();
    const values = new Map<string, string>();
    if (initial !== null) values.set(GENERAL_PREFERENCES_KEY, initial);
    const localStorage = {
      getItem: vi.fn((key: string) => values.get(key) ?? null),
      setItem: vi.fn((key: string, value: string) => void values.set(key, value)),
    };
    vi.stubGlobal("window", Object.assign(target, { localStorage }));
    return { target, values, localStorage };
  }

  it("uses safe defaults for malformed storage and rejects unsupported individual values", () => {
    for (const raw of [null, "", "not json", "[]", "null", "42"])
      expect(parseGeneralPreferences(raw)).toBe(DEFAULT_GENERAL_PREFERENCES);
    expect(
      parseGeneralPreferences(
        JSON.stringify({
          sendShortcut: "alt-enter",
          confirmBeforeClose: "false",
          openSidePanelByDefault: false,
          turnCompletionNotifications: "sometimes",
          permissionNotifications: false,
          notificationSound: "default",
        }),
      ),
    ).toEqual({
      ...DEFAULT_GENERAL_PREFERENCES,
      openSidePanelByDefault: false,
      permissionNotifications: false,
    });
  });

  it("persists independently changed shortcuts, panel defaults and notifications across a reload", async () => {
    const { values } = browser();
    const store = await import("./general-preferences");
    expect(store.updateGeneralPreferences({ sendShortcut: "mod-enter" })).toBe(true);
    expect(
      store.updateGeneralPreferences({ confirmBeforeClose: false, openSidePanelByDefault: false }),
    ).toBe(true);
    expect(
      store.updateGeneralPreferences({
        turnCompletionNotifications: "always",
        permissionNotifications: false,
        notificationSound: "chime",
      }),
    ).toBe(true);
    const expected = {
      sendShortcut: "mod-enter",
      confirmBeforeClose: false,
      openSidePanelByDefault: false,
      turnCompletionNotifications: "always",
      permissionNotifications: false,
      notificationSound: "chime",
    };
    expect(parseGeneralPreferences(values.get(GENERAL_PREFERENCES_KEY)!)).toEqual(expected);
    vi.resetModules();
    const reloaded = await import("./general-preferences");
    expect(reloaded.readGeneralPreferences()).toEqual(expected);
    expect(reloaded.readGeneralPreferences()).toBe(reloaded.readGeneralPreferences());
  });

  it("updates the current page and other tabs, including browser storage clearing", async () => {
    const { target, values } = browser();
    const store = await import("./general-preferences");
    const listener = vi.fn();
    const unsubscribe = store.subscribeGeneralPreferences(listener);
    store.updateGeneralPreferences({ sendShortcut: "mod-enter" });
    expect(listener).toHaveBeenCalledTimes(1);
    values.set(GENERAL_PREFERENCES_KEY, JSON.stringify({ turnCompletionNotifications: "never" }));
    target.dispatchEvent(Object.assign(new Event("storage"), { key: GENERAL_PREFERENCES_KEY }));
    expect(listener).toHaveBeenCalledTimes(2);
    expect(store.readGeneralPreferences().turnCompletionNotifications).toBe("never");
    target.dispatchEvent(Object.assign(new Event("storage"), { key: "unrelated" }));
    expect(listener).toHaveBeenCalledTimes(2);
    values.clear();
    target.dispatchEvent(Object.assign(new Event("storage"), { key: null }));
    expect(listener).toHaveBeenCalledTimes(3);
    expect(store.readGeneralPreferences()).toEqual(DEFAULT_GENERAL_PREFERENCES);
    unsubscribe();
    target.dispatchEvent(Object.assign(new Event("storage"), { key: GENERAL_PREFERENCES_KEY }));
    expect(listener).toHaveBeenCalledTimes(3);
  });

  it("reports a failed save while preserving successive choices for the current page", async () => {
    const { localStorage } = browser();
    const store = await import("./general-preferences");
    localStorage.setItem.mockImplementation(() => {
      throw new Error("Storage full");
    });
    expect(store.updateGeneralPreferences({ sendShortcut: "mod-enter" })).toBe(false);
    expect(store.updateGeneralPreferences({ openSidePanelByDefault: false })).toBe(false);
    expect(store.readGeneralPreferences()).toMatchObject({
      sendShortcut: "mod-enter",
      openSidePanelByDefault: false,
    });
    localStorage.getItem.mockImplementation(() => {
      throw new Error("Storage blocked");
    });
    expect(store.readGeneralPreferences().sendShortcut).toBe("mod-enter");
    expect(store.updateGeneralPreferences({ confirmBeforeClose: false })).toBe(false);
    expect(store.readGeneralPreferences().confirmBeforeClose).toBe(false);
  });

  it("has a stable server snapshot without accessing browser APIs", async () => {
    const store = await import("./general-preferences");
    expect(store.readGeneralPreferences()).toBe(store.DEFAULT_GENERAL_PREFERENCES);
    expect(store.updateGeneralPreferences({ sendShortcut: "mod-enter" })).toBe(false);
    expect(() => store.subscribeGeneralPreferences(vi.fn())()).not.toThrow();
  });
});

describe("configured composer shortcut", () => {
  it("sends with Enter by default and leaves Shift + Enter available for a new line", () => {
    expect(shouldSubmitComposer({ key: "Enter" }, "enter")).toBe(true);
    expect(shouldSubmitComposer({ key: "Enter", shiftKey: true }, "enter")).toBe(false);
    expect(shouldSubmitComposer({ key: "Enter", altKey: true }, "enter")).toBe(false);
    expect(shouldSubmitComposer({ key: "Escape" }, "enter")).toBe(false);
    expect(composerShortcutHint("enter")).toBe("Enter to send. Shift + Enter for a new line.");
  });

  it("requires Ctrl or Cmd for the alternate shortcut while preserving plain Enter", () => {
    expect(shouldSubmitComposer({ key: "Enter" }, "mod-enter")).toBe(false);
    expect(shouldSubmitComposer({ key: "Enter", ctrlKey: true }, "mod-enter")).toBe(true);
    expect(shouldSubmitComposer({ key: "Enter", metaKey: true }, "mod-enter")).toBe(true);
    expect(shouldSubmitComposer({ key: "Enter", ctrlKey: true, shiftKey: true }, "mod-enter")).toBe(
      false,
    );
    expect(shouldSubmitComposer({ key: "Enter", metaKey: true, altKey: true }, "mod-enter")).toBe(
      false,
    );
    expect(composerShortcutHint("mod-enter")).toBe(
      "Ctrl / Cmd + Enter to send. Enter for a new line.",
    );
  });

  it("never sends an IME composition Enter, including the legacy keyCode 229 fallback", () => {
    for (const shortcut of ["enter", "mod-enter"] as const) {
      expect(
        shouldSubmitComposer({ key: "Enter", ctrlKey: true, isComposing: true }, shortcut),
      ).toBe(false);
      expect(shouldSubmitComposer({ key: "Enter", metaKey: true, keyCode: 229 }, shortcut)).toBe(
        false,
      );
    }
  });
});

describe("close confirmation eligibility", () => {
  it("warns only for an enabled setting and unsent text or current active work", () => {
    expect(shouldConfirmBeforeClose({ enabled: true, prompt: "Draft", active: false })).toBe(true);
    expect(shouldConfirmBeforeClose({ enabled: true, prompt: "", active: true })).toBe(true);
    expect(shouldConfirmBeforeClose({ enabled: true, prompt: " \n ", active: false })).toBe(false);
    expect(shouldConfirmBeforeClose({ enabled: false, prompt: "Draft", active: true })).toBe(false);
  });
});

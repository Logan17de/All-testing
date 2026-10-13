import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  CHAT_PREFERENCES_KEY,
  CHAT_TOOL_OPTIONS,
  DEFAULT_CHAT_PREFERENCES,
  chatTaskOptions,
  parseChatPreferences,
} from "./chat-preferences";

describe("chat preferences", () => {
  beforeEach(() => vi.resetModules());
  afterEach(() => vi.unstubAllGlobals());

  function browser(initial: string | null = null) {
    const target = new EventTarget();
    const values = new Map<string, string>();
    if (initial !== null) values.set(CHAT_PREFERENCES_KEY, initial);
    const localStorage = {
      getItem: vi.fn((key: string) => values.get(key) ?? null),
      setItem: vi.fn((key: string, value: string) => void values.set(key, value)),
    };
    vi.stubGlobal("window", Object.assign(target, { localStorage }));
    return { target, values, localStorage };
  }

  it("defaults every tool choice to checked and tolerates missing or invalid saved values", () => {
    for (const raw of [null, "", "not json", "[]", "null", "42"])
      expect(parseChatPreferences(raw)).toBe(DEFAULT_CHAT_PREFERENCES);
    const parsed = parseChatPreferences(
      JSON.stringify({ instructions: 42, searchEnabled: "false", mutationConsent: false }),
    );
    expect(parsed.instructions).toBe("");
    expect(parsed.mutationConsent).toBe(false);
    for (const option of CHAT_TOOL_OPTIONS.filter((id) => id !== "mutationConsent"))
      expect(parsed[option]).toBe(true);
  });

  it("persists user choices and instructions across page reloads", async () => {
    const { values } = browser();
    const store = await import("./chat-preferences");
    expect(store.readChatPreferences()).toEqual(DEFAULT_CHAT_PREFERENCES);
    expect(
      store.updateChatPreferences({ searchEnabled: false, instructions: "Keep it concise" }),
    ).toBe(true);
    expect(store.updateChatPreferences({ browserEnabled: false })).toBe(true);
    const expected = {
      ...DEFAULT_CHAT_PREFERENCES,
      searchEnabled: false,
      browserEnabled: false,
      instructions: "Keep it concise",
    };
    expect(parseChatPreferences(values.get(CHAT_PREFERENCES_KEY)!)).toEqual(expected);
    vi.resetModules();
    const reloaded = await import("./chat-preferences");
    expect(reloaded.readChatPreferences()).toEqual(expected);
    expect(reloaded.readChatPreferences()).toBe(reloaded.readChatPreferences());
  });

  it("updates subscribers in this page and when preferences change in another tab", async () => {
    const { target, values } = browser();
    const store = await import("./chat-preferences");
    const listener = vi.fn();
    const unsubscribe = store.subscribeChatPreferences(listener);
    store.updateChatPreferences({ subagentsEnabled: false });
    expect(listener).toHaveBeenCalledTimes(1);
    values.set(CHAT_PREFERENCES_KEY, JSON.stringify({ desktopEnabled: false }));
    target.dispatchEvent(Object.assign(new Event("storage"), { key: CHAT_PREFERENCES_KEY }));
    expect(listener).toHaveBeenCalledTimes(2);
    expect(store.readChatPreferences().desktopEnabled).toBe(false);
    target.dispatchEvent(Object.assign(new Event("storage"), { key: "unrelated" }));
    expect(listener).toHaveBeenCalledTimes(2);
    unsubscribe();
    target.dispatchEvent(Object.assign(new Event("storage"), { key: null }));
    expect(listener).toHaveBeenCalledTimes(2);
  });

  it("retains choices for this page and reports failure when persistence is unavailable", async () => {
    const { localStorage } = browser();
    const store = await import("./chat-preferences");
    localStorage.setItem.mockImplementation(() => {
      throw new Error("Storage blocked");
    });
    expect(store.updateChatPreferences({ desktopEnabled: false })).toBe(false);
    expect(store.readChatPreferences().desktopEnabled).toBe(false);
    expect(store.updateChatPreferences({ instructions: "Still usable" })).toBe(false);
    expect(store.readChatPreferences()).toMatchObject({
      desktopEnabled: false,
      instructions: "Still usable",
    });
  });

  it("uses saved choices in successive submissions without changing options of a started task", async () => {
    browser();
    const store = await import("./chat-preferences");
    const started = store.chatTaskOptions(store.readChatPreferences());
    store.updateChatPreferences({ mutationConsent: false, instructions: "Next task only" });
    const next = store.chatTaskOptions(store.readChatPreferences());
    expect(started).toEqual({
      mutationConsent: true,
      subagentsEnabled: true,
      searchEnabled: true,
      browserEnabled: true,
      desktopEnabled: true,
    });
    expect(next).toMatchObject({ mutationConsent: false, instructions: "Next task only" });
    expect(store.chatTaskOptions(store.readChatPreferences())).toEqual(next);
    expect(
      chatTaskOptions({ ...DEFAULT_CHAT_PREFERENCES, instructions: " \n " }),
    ).not.toHaveProperty("instructions");
  });
});

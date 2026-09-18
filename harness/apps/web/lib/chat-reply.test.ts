import { afterEach, describe, expect, it, vi } from "vitest";

import {
  ANY_MODEL,
  editorLink,
  isReplyChoice,
  rememberChoice,
  rememberModel,
  rememberedChoice,
  rememberedModel,
  replyOutcome,
  runSettled,
} from "./chat-reply";

afterEach(() => {
  vi.unstubAllGlobals();
});

function fakeStorage(): Storage {
  const values = new Map<string, string>();
  return {
    get length() {
      return values.size;
    },
    clear: () => {
      values.clear();
    },
    getItem: (key) => values.get(key) ?? null,
    key: (index) => [...values.keys()][index] ?? null,
    removeItem: (key) => {
      values.delete(key);
    },
    setItem: (key, value) => {
      values.set(key, value);
    },
  };
}

describe("who answers a conversation", () => {
  it("remembers the choice per conversation, and starts from Chat", () => {
    vi.stubGlobal("window", { localStorage: fakeStorage() });
    expect(rememberedChoice("a")).toBe("chat");
    rememberChoice("a", "chat-github");
    expect(rememberedChoice("a")).toBe("chat-github");
    expect(rememberedChoice("b")).toBe("chat");
  });

  it("still works where the browser keeps nothing", () => {
    vi.stubGlobal("window", {
      get localStorage(): Storage {
        throw new Error("blocked");
      },
    });
    expect(rememberedChoice("a")).toBe("chat");
    expect(() => {
      rememberChoice("a", "none");
    }).not.toThrow();
  });

  it("knows its own choices only", () => {
    expect(isReplyChoice("chat")).toBe(true);
    expect(isReplyChoice("none")).toBe(true);
    expect(isReplyChoice("chat-slack")).toBe(false);
  });
});

describe("which model answers", () => {
  it("remembers the model per conversation, and otherwise lets the runtime choose", () => {
    vi.stubGlobal("window", { localStorage: fakeStorage() });
    expect(rememberedModel("a", ["grok-4"])).toBe(ANY_MODEL);
    rememberModel("a", "grok-4");
    expect(rememberedModel("a", ["grok-4", "gpt-5"])).toBe("grok-4");
    expect(rememberedModel("b", ["grok-4"])).toBe(ANY_MODEL);
    // A model that has since been removed is not asked for again.
    expect(rememberedModel("a", ["gpt-5"])).toBe(ANY_MODEL);
    rememberModel("a", ANY_MODEL);
    expect(rememberedModel("a", ["grok-4"])).toBe(ANY_MODEL);
  });

  it("still works where the browser keeps nothing", () => {
    vi.stubGlobal("window", {
      get localStorage(): Storage {
        throw new Error("blocked");
      },
    });
    expect(rememberedModel("a", ["grok-4"])).toBe(ANY_MODEL);
    expect(() => {
      rememberModel("a", "grok-4");
    }).not.toThrow();
  });
});

describe("following a reply", () => {
  it("knows when a run has nothing more to do on its own", () => {
    expect(runSettled("running")).toBe(false);
    expect(runSettled("pending")).toBe(false);
    for (const status of ["completed", "failed", "cancelled", "waiting"]) {
      expect(runSettled(status)).toBe(true);
    }
  });

  it("says nothing about a reply that finished, and something about one that did not", () => {
    expect(replyOutcome("completed")).toBeNull();
    expect(replyOutcome("failed")).toBe("The reply did not finish.");
    expect(replyOutcome("waiting")).toContain("approve");
    // What the run itself said comes after, so a person knows what to fix.
    expect(replyOutcome("failed", "The endpoint refused the key (HTTP 401).")).toBe(
      "The reply did not finish. The endpoint refused the key (HTTP 401).",
    );
    expect(replyOutcome("completed", "ignored")).toBeNull();
  });

  it("opens the conversation's workflow in the editor", () => {
    expect(editorLink("chat-github", "c-1")).toBe("/editor?workflow=chat-github&conversation=c-1");
  });
});

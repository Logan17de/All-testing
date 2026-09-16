import { afterEach, describe, expect, it, vi } from "vitest";

import {
  NO_MEMORY_FILTER,
  changeMemory,
  forgetMemory,
  listMemories,
  memoryListUrl,
  rememberMemory,
  type MemoryView,
} from "./memory-client";

const ID = "01890a5d-ac96-774b-bcce-b302099a8057";

const MEMORY: MemoryView = {
  memoryId: "01890a5d-ac96-774b-bcce-b302099a8058",
  projectId: ID,
  kind: "decision",
  title: "Ship on Fridays",
  body: "Releases go out on Friday mornings.",
  pinned: true,
  source: "person",
  sourceRunId: null,
  createdAtMs: 1,
  updatedAtMs: 2,
};

interface Call {
  readonly url: string;
  readonly init: RequestInit | undefined;
}

function stubFetch(status: number, body: unknown): { readonly calls: readonly Call[] } {
  const calls: Call[] = [];
  vi.stubGlobal("fetch", (url: string, init?: RequestInit) => {
    calls.push({ url, init });
    return Promise.resolve(
      new Response(JSON.stringify(body), {
        status,
        headers: { "content-type": "application/json" },
      }),
    );
  });
  return { calls };
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("memory list urls", () => {
  it("asks for everything when nothing is filtered", () => {
    expect(memoryListUrl(ID, NO_MEMORY_FILTER)).toBe(`/api/editor/projects/${ID}/memories`);
  });

  it("carries the filters a reader chose, trimming the search", () => {
    expect(memoryListUrl(ID, { search: "  budget ", kind: "decision", pinnedOnly: true })).toBe(
      `/api/editor/projects/${ID}/memories?pinned=true&kind=decision&q=budget`,
    );
  });

  it("leaves out a search that is only spaces", () => {
    expect(memoryListUrl(ID, { search: "   ", kind: "", pinnedOnly: false })).toBe(
      `/api/editor/projects/${ID}/memories`,
    );
  });
});

describe("memory requests", () => {
  it("reads a project's memories through the guarded proxy", async () => {
    const { calls } = stubFetch(200, { memories: [MEMORY] });
    const result = await listMemories(ID, NO_MEMORY_FILTER);
    expect(result).toEqual({ ok: true, data: [MEMORY] });
    expect(calls[0]?.url).toBe(`/api/editor/projects/${ID}/memories`);
    expect(calls[0]?.init?.method).toBeUndefined();
  });

  it("writes, changes and forgets with the JSON content type the runtime requires", async () => {
    const written = stubFetch(201, { memory: MEMORY });
    await rememberMemory(ID, { title: "Ship on Fridays", body: "…", kind: "decision" });
    expect(written.calls[0]?.init?.method).toBe("POST");
    expect(written.calls[0]?.init?.headers).toEqual({ "content-type": "application/json" });
    expect(written.calls[0]?.init?.body).toBe(
      JSON.stringify({ title: "Ship on Fridays", body: "…", kind: "decision" }),
    );
    vi.unstubAllGlobals();

    const changed = stubFetch(200, { memory: MEMORY });
    await changeMemory(MEMORY.memoryId, { pinned: false });
    expect(changed.calls[0]?.url).toBe(`/api/editor/memories/${MEMORY.memoryId}`);
    expect(changed.calls[0]?.init?.method).toBe("PATCH");
    expect(changed.calls[0]?.init?.body).toBe(JSON.stringify({ pinned: false }));
    vi.unstubAllGlobals();

    const forgotten = stubFetch(200, { forgotten: true });
    expect(await forgetMemory(MEMORY.memoryId)).toEqual({ ok: true, data: true });
    expect(forgotten.calls[0]?.init?.method).toBe("DELETE");
    expect(forgotten.calls[0]?.init?.headers).toEqual({ "content-type": "application/json" });
    expect(forgotten.calls[0]?.init?.body).toBeUndefined();
  });

  it("reports the runtime's own reason for a refusal", async () => {
    stubFetch(409, {
      error: { code: "PROJECT_ARCHIVED", reason: "An archived project remembers nothing new." },
    });
    expect(await rememberMemory(ID, { title: "x", body: "y", kind: "note" })).toEqual({
      ok: false,
      reason: "An archived project remembers nothing new.",
    });
  });

  it("says the daemon is unreachable rather than throwing at the panel", async () => {
    vi.stubGlobal("fetch", () => Promise.reject(new Error("connection refused")));
    expect(await listMemories(ID, NO_MEMORY_FILTER)).toEqual({
      ok: false,
      reason: "The runtime daemon is not reachable.",
    });
  });
});

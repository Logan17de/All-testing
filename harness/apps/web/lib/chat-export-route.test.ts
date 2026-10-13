import { afterEach, describe, expect, it, vi } from "vitest";
import { GET } from "../app/api/editor/chat-export/[sessionId]/route";
import { getFromRuntime, postToRuntime } from "./runtime-client";
vi.mock("./runtime-client", () => ({ getFromRuntime: vi.fn(), postToRuntime: vi.fn() }));
afterEach(() => vi.resetAllMocks());
const id = "01a110b8-292d-73a8-a47d-16da3b861b38";
const context = (sessionId = id) => ({ params: Promise.resolve({ sessionId }) });
const request = (site = "same-origin") =>
  new Request(`http://localhost:3005/api/editor/chat-export/${id}`, {
    headers: { "sec-fetch-site": site },
  });
describe("read-only local Markdown attachment route", () => {
  it("returns exact readable bytes with fixed download headers, using only the selected chat action", async () => {
    vi.mocked(getFromRuntime).mockResolvedValue({
      status: 200,
      body: { sessionFeatures: { export: true } },
    });
    const content = "# Fixture\n\n## User\nHello\n";
    vi.mocked(postToRuntime).mockResolvedValue({
      status: 200,
      body: {
        result: {
          export: { filename: `chat-${id}.md`, content, mediaType: "text/markdown; charset=utf-8" },
        },
      },
    });
    const response = await GET(request(), context());
    expect(response.status).toBe(200);
    expect(await response.text()).toBe(content);
    expect(response.headers.get("content-disposition")).toBe(
      `attachment; filename="chat-${id}.md"`,
    );
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(response.headers.get("x-content-type-options")).toBe("nosniff");
    expect(postToRuntime).toHaveBeenCalledExactlyOnceWith("/api/agent", {
      action: "session/export",
      params: { sessionId: id },
    });
  });
  it("refuses cross-site, invalid ids and unavailable older runtime before export", async () => {
    expect((await GET(request("cross-site"), context())).status).toBe(403);
    expect((await GET(request(), context("../bad"))).status).toBe(400);
    vi.mocked(getFromRuntime).mockResolvedValue({ status: 200, body: {} });
    expect((await GET(request(), context())).status).toBe(409);
    expect(postToRuntime).not.toHaveBeenCalled();
  });
  it("relays backend refusal and rejects unsafe attachment metadata without pretending success", async () => {
    vi.mocked(getFromRuntime).mockResolvedValue({
      status: 200,
      body: { sessionFeatures: { export: true } },
    });
    vi.mocked(postToRuntime).mockResolvedValueOnce({
      status: 404,
      body: { error: { reason: "Missing chat" } },
    });
    expect((await GET(request(), context())).status).toBe(404);
    vi.mocked(postToRuntime).mockResolvedValueOnce({
      status: 200,
      body: {
        result: {
          export: {
            filename: "../bad.md",
            content: "x",
            mediaType: "text/markdown; charset=utf-8",
          },
        },
      },
    });
    expect((await GET(request(), context())).status).toBe(502);
  });
});

import { describe, expect, it } from "vitest";
import { emptyGraph } from "../../lib/graph-document";
import { chatGraph } from "./chat-graph-view";
import { chatMessages } from "./chat-message-view";
describe("chat graph association", () => {
  it("supports no graph and empty graphs without mixing chats", () => {
    expect(chatGraph({ sessionId: "one", graphId: null, graph: null }, "one")).toEqual({
      sessionId: "one",
      graphId: null,
      graph: null,
    });
    const graph = emptyGraph("native-chat:one");
    expect(
      chatGraph({ sessionId: "one", graphId: graph.graphId, graph }, "one")?.graph?.nodes,
    ).toEqual([]);
    expect(chatGraph({ sessionId: "other", graphId: graph.graphId, graph }, "one")).toBeUndefined();
    expect(chatGraph({ sessionId: "one", graphId: "another", graph }, "one")).toBeUndefined();
  });
  it("rejects absent or malformed linked documents", () => {
    for (const graph of [null, {}, "private", { schemaVersion: 1, nodes: [] }])
      expect(
        chatGraph({ sessionId: "one", graphId: "native-chat:one", graph }, "one"),
      ).toBeUndefined();
    expect(chatMessages({ messages: [null, { role: "user", parts: [] }] })).toEqual([]);
  });
});

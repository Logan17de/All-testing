import { parseGraphDocument, type GraphDocument } from "../../lib/graph-document";
export interface ChatGraph {
  sessionId: string;
  graphId: string | null;
  graph: GraphDocument | null;
}
export function chatGraph(value: unknown, sessionId: string): ChatGraph | undefined {
  if (!value || typeof value !== "object") return;
  const data = value as Record<string, unknown>;
  if (data.sessionId !== sessionId || !(data.graphId === null || typeof data.graphId === "string"))
    return;
  if (data.graphId === null)
    return data.graph === null ? { sessionId, graphId: null, graph: null } : undefined;
  const graph = parseGraphDocument(data.graph);
  if (!graph || graph.graphId !== data.graphId) return;
  return { sessionId, graphId: data.graphId, graph };
}

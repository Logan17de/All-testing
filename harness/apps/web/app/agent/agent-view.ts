export type AgentRun = { id: string; status: string };
export type AgentEvent = { sequence: number; type: string; params: Record<string, unknown> };
const object = (value: unknown): Record<string, unknown> =>
  value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
export function agentRuns(value: unknown): Record<string, AgentRun> {
  const result: Record<string, AgentRun> = {};
  for (const [sessionId, raw] of Object.entries(object(value))) {
    const run = object(raw);
    if (typeof run.id === "string" && typeof run.status === "string")
      result[sessionId] = { id: run.id, status: run.status };
  }
  return result;
}
export function agentEvents(value: unknown, runId?: string): AgentEvent[] {
  if (!Array.isArray(value)) return [];
  const events = new Map<number, AgentEvent>();
  for (const raw of value) {
    const event = object(raw);
    const params = object(event.params);
    if (
      typeof event.sequence !== "number" ||
      typeof event.type !== "string" ||
      (runId && params.runId !== runId)
    )
      continue;
    events.set(event.sequence, { sequence: event.sequence, type: event.type, params });
  }
  return [...events.values()].sort((left, right) => right.sequence - left.sequence);
}
export function agentEventLabel(event: AgentEvent): string {
  const name = typeof event.params.eventType === "string" ? event.params.eventType : event.type;
  return name.replace(/^harness[./]/, "").replace(/[._/]/g, " ");
}

export type MutationApproval = {
  id: string;
  runId: string;
  sessionId: string;
  tool: string;
  args: unknown;
  requestGeneration: number;
  expiresAtMs: number;
};
export function mutationApprovals(
  value: unknown,
  sessionId: string,
  runId?: string,
): MutationApproval[] {
  if (!Array.isArray(value) || !runId) return [];
  return value.flatMap((raw) => {
    const request = object(raw);
    return typeof request.id === "string" &&
      typeof request.tool === "string" &&
      request.sessionId === sessionId &&
      request.runId === runId &&
      typeof request.requestGeneration === "number" &&
      typeof request.expiresAtMs === "number"
      ? [
          {
            id: request.id,
            tool: request.tool,
            runId,
            sessionId,
            args: request.args,
            requestGeneration: request.requestGeneration,
            expiresAtMs: request.expiresAtMs,
          },
        ]
      : [];
  });
}

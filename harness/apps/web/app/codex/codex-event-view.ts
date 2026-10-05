export type NativeEvent = { sequence: number; method: string; params: unknown };
const object = (value: unknown): Record<string, unknown> =>
  value && typeof value === "object" ? (value as Record<string, unknown>) : {};
const text = (value: unknown) => (typeof value === "string" ? value : "");

export function eventView(event: NativeEvent): { title: string; text: string } {
  const params = object(event.params);
  const item = object(params.item);
  const labels: Record<string, string> = {
    "turn/started": "Task started",
    "turn/completed": "Task finished",
    "item/agentMessage/delta": "Assistant response",
    "item/reasoning/textDelta": "Reasoning",
    "item/commandExecution/outputDelta": "Command output",
    "item/fileChange/outputDelta": "File change",
    "thread/tokenUsage/updated": "Context usage updated",
    "account/login/completed": "Login completed",
  };
  return {
    title:
      labels[event.method] ||
      (event.method === "item/started" || event.method === "item/completed"
        ? `${text(item.type) || "Agent action"} ${event.method.endsWith("started") ? "started" : "completed"}`
        : event.method),
    text:
      text(params.delta) || text(item.text) || text(item.aggregatedOutput) || text(params.message),
  };
}

export function turnProgress(
  events: readonly NativeEvent[],
  threadId: string,
  turnId: string,
): { active: boolean; label: string } {
  if (!turnId) return { active: false, label: "Ready for a task." };
  for (let index = events.length - 1; index >= 0; index--) {
    const event = events[index]!;
    const params = object(event.params);
    if (params.threadId !== threadId) continue;
    const turn = object(params.turn);
    if (event.method === "turn/completed" && turn.id === turnId) {
      return { active: false, label: `Task ${text(turn.status) || "completed"}.` };
    }
  }
  return { active: true, label: "Codex is working. Tool output and approvals appear below." };
}

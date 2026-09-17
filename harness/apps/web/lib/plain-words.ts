/**
 * The words a person sees in place of the harness's internal names.
 *
 * Node types, plugin ids, event types and tool ids are stable identifiers the
 * runtime needs; they are not labels. Pages show these instead, and keep the
 * identifier out of the text entirely.
 */

/** "systemPrompt" → "System prompt"; a few settings get a clearer name. */
const FIELD_LABELS: Readonly<Record<string, string>> = {
  conversationId: "Conversation",
  systemPrompt: "Instructions",
  modelId: "Model",
  modelVersion: "Model version",
  reserveOutputTokens: "Tokens kept for the reply",
  maxOutputTokens: "Longest reply (tokens)",
  maxContextBytes: "Largest context (bytes)",
  maxMemories: "Memories to include",
  summaryMaxOutputTokens: "Longest summary (tokens)",
  maxModelCalls: "Most model calls",
  maxTokens: "Most tokens",
  maxCost: "Most cost",
  maxToolCalls: "Most tool calls",
  allowedTools: "Only these tools",
  maxIterations: "Most rounds",
  maxWallTimeMs: "Time limit (ms)",
};

export function fieldLabel(key: string): string {
  const known = FIELD_LABELS[key];
  if (known !== undefined) return known;
  const words = key
    .replace(/([a-z0-9])([A-Z])/gu, "$1 $2")
    .replace(/[_.-]+/gu, " ")
    .trim()
    .toLowerCase();
  if (words.length === 0) return key;
  return `${words.charAt(0).toUpperCase()}${words.slice(1)}`.replace(/\bid\b/gu, "ID");
}

const PLUGIN_LABELS: Readonly<Record<string, string>> = {
  "harness.agent-plugin": "Agent",
  "harness.control-flow-plugin": "Control flow",
  "harness.human-approval-plugin": "People",
  "harness.github-plugin": "GitHub",
  host: "Built in",
};

/** A plugin's name as a person would say it. */
export function pluginLabel(pluginId: string): string {
  const known = PLUGIN_LABELS[pluginId];
  if (known !== undefined) return known;
  const last = pluginId.split(".").pop() ?? pluginId;
  return fieldLabel(last.replace(/-?plugin$/u, "") || last);
}

/** Scheduling bookkeeping a person has no use for in a timeline. */
export function isInternalEvent(eventType: string): boolean {
  return (
    eventType === "harness.frontier.op" ||
    eventType === "harness.frontier.control-edge" ||
    eventType === "harness.approval.token-rotated"
  );
}

const EVENT_LABELS: Readonly<Record<string, string>> = {
  "harness.attempt.started": "started",
  "harness.attempt.completed": "finished",
  "harness.attempt.failed": "failed",
  "harness.loop.entered": "loop started",
  "harness.loop.advanced": "loop moved on",
  "harness.frontier.router-selection": "chose a branch",
  "harness.approval.requested": "waiting for a person",
  "harness.approval.resolved": "answered by a person",
  "harness.effect.recovery-outcome": "checked after an interruption",
  "harness.run.budget-exceeded": "stopped: over its limits",
  "harness.run.completed": "run finished",
  "harness.run.failed": "run failed",
  "harness.run.cancelled": "run cancelled",
  "harness.run.forked": "run forked from another",
  "harness.run.identity-mismatch": "stopped: the plan changed",
};

/** What a recorded event means, in a few words. */
export function eventLabel(eventType: string): string {
  const known = EVENT_LABELS[eventType];
  if (known !== undefined) return known;
  const parts = eventType.replace(/^harness\./u, "").split(".");
  return fieldLabel(parts.join(" ")).toLowerCase();
}

const TOOL_LABELS: Readonly<Record<string, string>> = {
  harness_goals_list: "List goals",
  harness_goals_get: "Read a goal",
  harness_goals_create: "Create a goal",
  "harness_goals_set-status": "Change a goal's status",
  harness_todos_create: "Add a todo",
  harness_todos_update: "Change a todo",
  "harness_todos_set-status": "Change a todo's status",
  harness_todos_next: "Find the next todo",
  harness_memory_list: "Look through memories",
  harness_memory_remember: "Remember something",
  harness_memory_update: "Change a memory",
  github_repo_get: "Read a GitHub repository",
  github_issues_list: "List GitHub issues",
  github_issue_get: "Read a GitHub issue",
  github_pulls_list: "List GitHub pull requests",
  github_file_get: "Read a file on GitHub",
};

/** A tool a model called, by what it does rather than its id. */
export function toolLabel(name: string): string {
  const known = TOOL_LABELS[name];
  if (known !== undefined) return known;
  return fieldLabel(name.replace(/^harness_/u, ""));
}

const CAPABILITY_LABELS: Readonly<Record<string, string>> = {
  "network:https": "Internet (https)",
  "network:http": "Network (http)",
  "fs:read": "Read files",
  "fs:write": "Write files",
  "shell:run": "Run commands",
  "git:read": "Read git history",
  "git:write": "Change git history",
};

/** A permission, as a person would ask for it. */
export function capabilityLabel(capability: string): string {
  return CAPABILITY_LABELS[capability] ?? capability;
}

/** "local-llama@1" → "local-llama": the version is the runtime's business. */
export function modelLabel(model: string): string {
  return model.replace(/@[^@]*$/u, "");
}

const EFFECT_LABELS: Readonly<Record<string, string>> = {
  none: "Changes nothing outside the graph",
  "external-read": "Reads from outside the graph",
  "external-write": "Changes things outside the graph",
};

const RECOVERY_LABELS: Readonly<Record<string, string>> = {
  rerun: "safe to run again",
  manual: "needs a person if it is interrupted",
  reconcile: "checked before it runs again",
};

/** What a node does to the world, and what happens if a run is interrupted there. */
export function behaviourLabel(effect: string, recovery: string): string {
  return `${EFFECT_LABELS[effect] ?? fieldLabel(effect)}; ${RECOVERY_LABELS[recovery] ?? recovery}.`;
}

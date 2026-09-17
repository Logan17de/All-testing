/**
 * Who answers a conversation, and how the chat page follows a reply.
 *
 * A reply is a run of a ready-made workflow. The page starts it, watches the run
 * until it settles, and then reads the conversation again — the answer is already
 * there, written by the run's own agent steps.
 */

export const REPLY_CHOICES = [
  { id: "chat", label: "Chat" },
  { id: "chat-github", label: "Chat with GitHub" },
  { id: "none", label: "Nobody — just save messages" },
] as const;

export type ReplyChoice = (typeof REPLY_CHOICES)[number]["id"];
export type WorkflowChoice = Exclude<ReplyChoice, "none">;

export function isReplyChoice(value: unknown): value is ReplyChoice {
  return REPLY_CHOICES.some((choice) => choice.id === value);
}

const STORAGE_PREFIX = "zet-harness.chat.answered-by.";
const MODEL_PREFIX = "zet-harness.chat.model.";

/** Any configured model that can do the job, rather than one a person named. */
export const ANY_MODEL = "";

/** The choice made for this conversation before, or Chat. */
export function rememberedChoice(conversationId: string): ReplyChoice {
  try {
    const stored = window.localStorage.getItem(`${STORAGE_PREFIX}${conversationId}`);
    return isReplyChoice(stored) ? stored : "chat";
  } catch {
    return "chat";
  }
}

export function rememberChoice(conversationId: string, choice: ReplyChoice): void {
  try {
    window.localStorage.setItem(`${STORAGE_PREFIX}${conversationId}`, choice);
  } catch {
    // Remembering is a convenience; the page works without it.
  }
}

/**
 * The model chosen for this conversation before, if it is still configured.
 *
 * A model belongs to the harness, not to a project: a conversation only remembers
 * which of them a person last picked, and falls back to letting the runtime choose.
 */
export function rememberedModel(conversationId: string, configured: readonly string[]): string {
  try {
    const stored = window.localStorage.getItem(`${MODEL_PREFIX}${conversationId}`);
    return stored !== null && configured.includes(stored) ? stored : ANY_MODEL;
  } catch {
    return ANY_MODEL;
  }
}

export function rememberModel(conversationId: string, modelId: string): void {
  try {
    if (modelId === ANY_MODEL) window.localStorage.removeItem(`${MODEL_PREFIX}${conversationId}`);
    else window.localStorage.setItem(`${MODEL_PREFIX}${conversationId}`, modelId);
  } catch {
    // Remembering is a convenience; the page works without it.
  }
}

/** Run states after which nothing more will happen without someone acting. */
const SETTLED = new Set([
  "completed",
  "failed",
  "cancelled",
  "waiting",
  "paused",
  "recovery-required",
]);

export function runSettled(status: string): boolean {
  return SETTLED.has(status);
}

/** What to tell a person about a reply that has settled, or nothing when it simply finished. */
export function replyOutcome(status: string): string | null {
  switch (status) {
    case "completed":
      return null;
    case "waiting":
      return "The reply is waiting for a person to approve something.";
    case "cancelled":
      return "The reply was cancelled.";
    case "failed":
      return "The reply did not finish.";
    default:
      return "The reply stopped before it finished.";
  }
}

/** Where the editor opens a workflow for this conversation. */
export function editorLink(workflow: WorkflowChoice, conversationId: string): string {
  const query = new URLSearchParams({ workflow, conversation: conversationId });
  return `/editor?${query.toString()}`;
}

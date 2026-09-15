/** Shapes the runtime returns for projects, conversations, goals and todos. */

export interface ProjectView {
  readonly projectId: string;
  readonly name: string;
  readonly description: string;
  readonly workspacePath: string | null;
  readonly status: "active" | "archived";
  readonly createdAtMs: number;
  readonly updatedAtMs: number;
  readonly archivedAtMs: number | null;
}

export interface ConversationView {
  readonly conversationId: string;
  readonly projectId: string;
  readonly title: string;
  readonly status: "active" | "archived";
  readonly createdAtMs: number;
  readonly updatedAtMs: number;
}

export type MessagePartView =
  | { readonly kind: "text"; readonly text: string }
  | { readonly kind: "reasoning"; readonly text: string }
  | { readonly kind: "image"; readonly artifactRef: string; readonly mediaType: string }
  | {
      readonly kind: "tool-call";
      readonly callId: string;
      readonly name: string;
      readonly arguments: Readonly<Record<string, unknown>>;
    }
  | {
      readonly kind: "tool-result";
      readonly callId: string;
      readonly value: unknown;
      readonly isError?: boolean;
    };

export interface MessageView {
  readonly messageId: string;
  readonly conversationId: string;
  readonly parentMessageId: string | null;
  readonly role: string;
  readonly parts: readonly MessagePartView[];
  readonly model: string | null;
  readonly runId: string | null;
  readonly createdAtMs: number;
}

export type GoalStatus = "open" | "blocked" | "completed" | "cancelled";
export type TodoStatus = "pending" | "in_progress" | "blocked" | "done" | "cancelled";

export interface GoalView {
  readonly goalId: string;
  readonly projectId: string;
  readonly title: string;
  readonly description: string;
  readonly status: GoalStatus;
  readonly blockedReason: string | null;
  readonly blockedBy?: "person" | "todos" | null;
  readonly priority: number;
  readonly updatedAtMs: number;
}

export interface TodoView {
  readonly todoId: string;
  readonly goalId: string;
  readonly title: string;
  readonly description: string;
  readonly status: TodoStatus;
  readonly blockedReason: string | null;
  readonly priority: number;
  readonly position: number;
  readonly dependsOn: readonly string[];
}

export interface StatusAction<Status extends string> {
  readonly label: string;
  readonly status: Status;
}

/** One-click todo changes; blocking asks for a reason separately. */
export const TODO_QUICK_ACTIONS: Readonly<Record<TodoStatus, readonly StatusAction<TodoStatus>[]>> =
  {
    pending: [
      { label: "Start", status: "in_progress" },
      { label: "Done", status: "done" },
      { label: "Cancel", status: "cancelled" },
    ],
    in_progress: [
      { label: "Done", status: "done" },
      { label: "Pause", status: "pending" },
      { label: "Cancel", status: "cancelled" },
    ],
    blocked: [
      { label: "Unblock", status: "pending" },
      { label: "Cancel", status: "cancelled" },
    ],
    done: [{ label: "Reopen", status: "pending" }],
    cancelled: [{ label: "Reopen", status: "pending" }],
  };

/** One-click goal changes available to a person. */
export const GOAL_QUICK_ACTIONS: Readonly<Record<GoalStatus, readonly StatusAction<GoalStatus>[]>> =
  {
    open: [{ label: "Cancel goal", status: "cancelled" }],
    blocked: [
      { label: "Unblock", status: "open" },
      { label: "Cancel goal", status: "cancelled" },
    ],
    completed: [{ label: "Reopen", status: "open" }],
    cancelled: [{ label: "Reopen", status: "open" }],
  };

/** Todo statuses from which a todo may be blocked. */
export const BLOCKABLE_TODO_STATUSES: ReadonlySet<TodoStatus> = new Set(["pending", "in_progress"]);

/**
 * The branch ending at the most recent message, oldest first.
 *
 * Messages arrive in the order they were stored; edits and retries are siblings, so
 * following parents from the newest message gives the branch the user sees now.
 */
export function latestBranch(messages: readonly MessageView[]): readonly MessageView[] {
  const byId = new Map(messages.map((message) => [message.messageId, message] as const));
  const branch: MessageView[] = [];
  const seen = new Set<string>();
  let current = messages[messages.length - 1];
  while (current !== undefined && !seen.has(current.messageId)) {
    seen.add(current.messageId);
    branch.push(current);
    current = current.parentMessageId === null ? undefined : byId.get(current.parentMessageId);
  }
  return branch.reverse();
}

/** The runtime's error reason, when the body carries one. */
export function reasonOf(body: unknown, fallback: string): string {
  if (typeof body === "object" && body !== null && "error" in body) {
    const error = (body as { readonly error: unknown }).error;
    if (typeof error === "object" && error !== null && "reason" in error) {
      const reason = (error as { readonly reason: unknown }).reason;
      if (typeof reason === "string") return reason;
    }
  }
  return fallback;
}

"use client";

import Link from "next/link";
import { useEffect, useState, type FormEvent } from "react";

import { workspaceRequest } from "../../../lib/workspace-client";
import {
  BLOCKABLE_TODO_STATUSES,
  GOAL_QUICK_ACTIONS,
  TODO_QUICK_ACTIONS,
  type ConversationView,
  type GoalView,
  type ProjectView,
  type TodoView,
} from "../../../lib/workspace-types";

interface WorkspaceState {
  readonly project: ProjectView;
  readonly conversations: readonly ConversationView[];
  readonly goals: readonly { readonly goal: GoalView; readonly todos: readonly TodoView[] }[];
  readonly nextTodoId: string | null;
}

type Loaded<T> =
  { readonly ok: true; readonly value: T } | { readonly ok: false; readonly reason: string };

async function loadWorkspace(projectId: string): Promise<Loaded<WorkspaceState>> {
  const [project, conversations, goals, next] = await Promise.all([
    workspaceRequest<{ readonly project: ProjectView }>(`projects/${projectId}`),
    workspaceRequest<{ readonly conversations: readonly ConversationView[] }>(
      `projects/${projectId}/conversations?status=all`,
    ),
    workspaceRequest<{ readonly goals: readonly GoalView[] }>(`projects/${projectId}/goals`),
    workspaceRequest<{ readonly todo: TodoView | null }>(`projects/${projectId}/todos/next`),
  ]);
  if (!project.ok) return { ok: false, reason: project.reason };
  if (!conversations.ok) return { ok: false, reason: conversations.reason };
  if (!goals.ok) return { ok: false, reason: goals.reason };
  if (!next.ok) return { ok: false, reason: next.reason };
  const withTodos = await Promise.all(
    goals.data.goals.map(async (goal) => {
      const detail = await workspaceRequest<{ readonly todos: readonly TodoView[] }>(
        `goals/${goal.goalId}`,
      );
      return { goal, todos: detail.ok ? detail.data.todos : [] };
    }),
  );
  return {
    ok: true,
    value: {
      project: project.data.project,
      conversations: conversations.data.conversations,
      goals: withTodos,
      nextTodoId: next.data.todo?.todoId ?? null,
    },
  };
}

/**
 * One project: its conversations, and its goals with their todos in the order they
 * should be done. Every change goes through the runtime, which applies the same
 * status rules, dependency checks and goal completion as the agent's own actions.
 */
export function ProjectWorkspace({ projectId }: { readonly projectId: string }) {
  const [state, setState] = useState<WorkspaceState | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [conversationTitle, setConversationTitle] = useState("");
  const [goalTitle, setGoalTitle] = useState("");
  const [todoTitles, setTodoTitles] = useState<Readonly<Record<string, string>>>({});
  const [blocking, setBlocking] = useState<{
    readonly todoId: string;
    readonly reason: string;
  } | null>(null);

  const [version, setVersion] = useState(0);

  useEffect(() => {
    let cancelled = false;
    void loadWorkspace(projectId).then((result) => {
      if (cancelled) return;
      if (result.ok) {
        setError(null);
        setState(result.value);
      } else {
        setError(result.reason);
      }
    });
    return () => {
      cancelled = true;
    };
  }, [projectId, version]);

  const change = async (path: string, body: unknown): Promise<boolean> => {
    setBusy(true);
    const result = await workspaceRequest<unknown>(path, body);
    setBusy(false);
    if (!result.ok) {
      setError(result.reason);
      return false;
    }
    setVersion((current) => current + 1);
    return true;
  };

  const createConversation = async (event: FormEvent<HTMLFormElement>): Promise<void> => {
    event.preventDefault();
    if (await change(`projects/${projectId}/conversations`, { title: conversationTitle })) {
      setConversationTitle("");
    }
  };

  const createGoal = async (event: FormEvent<HTMLFormElement>): Promise<void> => {
    event.preventDefault();
    if (await change(`projects/${projectId}/goals`, { title: goalTitle })) setGoalTitle("");
  };

  const createTodo = async (event: FormEvent<HTMLFormElement>, goalId: string): Promise<void> => {
    event.preventDefault();
    if (await change(`goals/${goalId}/todos`, { title: todoTitles[goalId] ?? "" })) {
      setTodoTitles((current) => ({ ...current, [goalId]: "" }));
    }
  };

  const blockTodo = async (event: FormEvent<HTMLFormElement>): Promise<void> => {
    event.preventDefault();
    if (blocking === null) return;
    if (
      await change(`todos/${blocking.todoId}/status`, {
        status: "blocked",
        reason: blocking.reason,
      })
    ) {
      setBlocking(null);
    }
  };

  if (state === null) {
    return (
      <div className="panel" role={error === null ? "status" : "alert"}>
        <p>{error ?? "Loading the project…"}</p>
      </div>
    );
  }

  const archived = state.project.status === "archived";

  return (
    <>
      <div className="pageHeader">
        <h1 className="pageTitle">{state.project.name}</h1>
        <span className="chip">{state.project.status}</span>
      </div>
      {state.project.description.length > 0 ? (
        <p className="lede">{state.project.description}</p>
      ) : null}
      {error === null ? null : (
        <p className="field__error" role="alert">
          {error}
        </p>
      )}

      <div className="workspaceGrid">
        <section className="panel" aria-label="Conversations">
          <h2 className="panelTitle">Conversations</h2>
          {state.conversations.length === 0 ? (
            <p className="muted">No conversations yet.</p>
          ) : (
            <ul className="todoList">
              {state.conversations.map((conversation) => (
                <li className="todoItem" key={conversation.conversationId}>
                  <Link href={`/conversations/${conversation.conversationId}`}>
                    {conversation.title.length > 0 ? conversation.title : "Untitled conversation"}
                  </Link>
                  <span className="muted small">
                    {conversation.status} · updated{" "}
                    {new Date(conversation.updatedAtMs).toLocaleString()}
                  </span>
                </li>
              ))}
            </ul>
          )}
          {archived ? null : (
            <form
              aria-label="New conversation"
              onSubmit={(event) => {
                void createConversation(event);
              }}
            >
              <label className="field">
                <span className="field__label">New conversation</span>
                <input
                  className="field__input"
                  value={conversationTitle}
                  maxLength={200}
                  placeholder="Title (optional)"
                  onChange={(event) => {
                    setConversationTitle(event.target.value);
                  }}
                />
              </label>
              <div className="btnRow">
                <button className="btn" type="submit" disabled={busy}>
                  Start conversation
                </button>
              </div>
            </form>
          )}
        </section>

        <section className="panel" aria-label="Goals">
          <h2 className="panelTitle">Goals</h2>
          {state.goals.length === 0 ? <p className="muted">No goals yet.</p> : null}
          {state.goals.map(({ goal, todos }) => (
            <article className="todoItem" key={goal.goalId} aria-label={`Goal ${goal.title}`}>
              <div className="cardHead">
                <strong>{goal.title}</strong>
                <span className="chip">{goal.status}</span>
              </div>
              {goal.blockedReason === null ? null : (
                <span className="muted small">
                  Blocked{goal.blockedBy === "todos" ? " by its todos" : ""}: {goal.blockedReason}
                </span>
              )}
              <div className="btnRow">
                {archived
                  ? null
                  : GOAL_QUICK_ACTIONS[goal.status]
                      .filter(
                        (action) =>
                          goal.status !== "blocked" ||
                          goal.blockedBy !== "todos" ||
                          action.status !== "open",
                      )
                      .map((action) => (
                        <button
                          key={action.status}
                          className="btn"
                          type="button"
                          disabled={busy}
                          onClick={() => {
                            void change(`goals/${goal.goalId}/status`, { status: action.status });
                          }}
                        >
                          {action.label}
                        </button>
                      ))}
              </div>

              <ul className="todoList">
                {todos.map((todo) => (
                  <li
                    key={todo.todoId}
                    className={`todoItem${todo.todoId === state.nextTodoId ? " todoItem--next" : ""}`}
                  >
                    <div className="cardHead">
                      <span>
                        {todo.title}
                        {todo.todoId === state.nextTodoId ? (
                          <span className="chip">next</span>
                        ) : null}
                      </span>
                      <span className="chip">{todo.status.replace("_", " ")}</span>
                    </div>
                    {todo.blockedReason === null ? null : (
                      <span className="muted small">Blocked: {todo.blockedReason}</span>
                    )}
                    {todo.dependsOn.length === 0 ? null : (
                      <span className="muted small">
                        Waits on {todo.dependsOn.length}{" "}
                        {todo.dependsOn.length === 1 ? "todo" : "todos"}
                      </span>
                    )}
                    {archived ||
                    goal.status === "completed" ||
                    goal.status === "cancelled" ? null : (
                      <div className="btnRow">
                        {TODO_QUICK_ACTIONS[todo.status].map((action) => (
                          <button
                            key={action.status}
                            className="btn"
                            type="button"
                            disabled={busy}
                            onClick={() => {
                              void change(`todos/${todo.todoId}/status`, { status: action.status });
                            }}
                          >
                            {action.label}
                          </button>
                        ))}
                        {BLOCKABLE_TODO_STATUSES.has(todo.status) ? (
                          <button
                            className="btn"
                            type="button"
                            disabled={busy}
                            onClick={() => {
                              setBlocking({ todoId: todo.todoId, reason: "" });
                            }}
                          >
                            Block…
                          </button>
                        ) : null}
                      </div>
                    )}
                    {blocking?.todoId === todo.todoId ? (
                      <form
                        aria-label={`Block ${todo.title}`}
                        onSubmit={(event) => {
                          void blockTodo(event);
                        }}
                      >
                        <label className="field">
                          <span className="field__label">Why is it blocked?</span>
                          <input
                            className="field__input"
                            value={blocking.reason}
                            maxLength={1000}
                            required
                            onChange={(event) => {
                              setBlocking({ todoId: todo.todoId, reason: event.target.value });
                            }}
                          />
                        </label>
                        <div className="btnRow">
                          <button
                            className="btn btn--danger"
                            type="submit"
                            disabled={busy || blocking.reason.trim().length === 0}
                          >
                            Block todo
                          </button>
                          <button
                            className="btn"
                            type="button"
                            onClick={() => {
                              setBlocking(null);
                            }}
                          >
                            Keep going
                          </button>
                        </div>
                      </form>
                    ) : null}
                  </li>
                ))}
              </ul>

              {archived || goal.status === "completed" || goal.status === "cancelled" ? null : (
                <form
                  aria-label={`New todo for ${goal.title}`}
                  onSubmit={(event) => {
                    void createTodo(event, goal.goalId);
                  }}
                >
                  <label className="field">
                    <span className="field__label">Add a todo</span>
                    <input
                      className="field__input"
                      value={todoTitles[goal.goalId] ?? ""}
                      maxLength={200}
                      onChange={(event) => {
                        const value = event.target.value;
                        setTodoTitles((current) => ({ ...current, [goal.goalId]: value }));
                      }}
                    />
                  </label>
                  <div className="btnRow">
                    <button
                      className="btn"
                      type="submit"
                      disabled={busy || (todoTitles[goal.goalId] ?? "").trim().length === 0}
                    >
                      Add todo
                    </button>
                  </div>
                </form>
              )}
            </article>
          ))}
          {archived ? null : (
            <form
              aria-label="New goal"
              onSubmit={(event) => {
                void createGoal(event);
              }}
            >
              <label className="field">
                <span className="field__label">New goal</span>
                <input
                  className="field__input"
                  value={goalTitle}
                  maxLength={200}
                  onChange={(event) => {
                    setGoalTitle(event.target.value);
                  }}
                />
              </label>
              <div className="btnRow">
                <button
                  className="btn btn--primary"
                  type="submit"
                  disabled={busy || goalTitle.trim().length === 0}
                >
                  Add goal
                </button>
              </div>
            </form>
          )}
        </section>
      </div>
    </>
  );
}

"use client";

import Link from "next/link";
import { useCallback, useEffect, useState, type FormEvent } from "react";

import {
  ANY_MODEL,
  REPLY_CHOICES,
  editorLink,
  isReplyChoice,
  rememberChoice,
  rememberModel,
  rememberedChoice,
  rememberedModel,
  replyOutcome,
  runSettled,
  type ReplyChoice,
  type WorkflowChoice,
} from "../../../lib/chat-reply";
import { describeFailure } from "../../../lib/failure-words";
import { isModelView, type ModelView } from "../../../lib/model-form";
import { modelLabel, toolLabel } from "../../../lib/plain-words";
import { workspaceRequest } from "../../../lib/workspace-client";
import {
  latestBranch,
  type ConversationView,
  type MessagePartView,
  type MessageView,
} from "../../../lib/workspace-types";

function Part({ part }: { readonly part: MessagePartView }) {
  switch (part.kind) {
    case "text":
      return <p className="chatText">{part.text}</p>;
    case "reasoning":
      return (
        <details>
          <summary className="muted small">Reasoning</summary>
          <p className="chatText muted">{part.text}</p>
        </details>
      );
    case "image":
      return (
        <p className="muted small">
          Image <code>{part.artifactRef}</code> ({part.mediaType})
        </p>
      );
    case "tool-call":
      return (
        <div>
          <span className="muted small">Uses {toolLabel(part.name)}</span>
          <pre className="codeBlock">{JSON.stringify(part.arguments, null, 2)}</pre>
        </div>
      );
    case "tool-result":
      return (
        <div>
          <span className="muted small">
            {part.isError === true ? "Tool error" : "Tool result"}
          </span>
          <pre className={`codeBlock${part.isError === true ? " codeBlock--error" : ""}`}>
            {JSON.stringify(part.value, null, 2)}
          </pre>
        </div>
      );
  }
}

type Loaded =
  | {
      readonly ok: true;
      readonly conversation: ConversationView;
      readonly messages: readonly MessageView[];
    }
  | { readonly ok: false; readonly reason: string };

async function loadConversation(conversationId: string): Promise<Loaded> {
  const result = await workspaceRequest<{
    readonly conversation: ConversationView;
    readonly messages: readonly MessageView[];
  }>(`conversations/${conversationId}`);
  return result.ok
    ? { ok: true, conversation: result.data.conversation, messages: result.data.messages }
    : { ok: false, reason: result.reason };
}

interface WorkflowSummary {
  readonly id: string;
  readonly available: boolean;
}

interface ReplyState {
  readonly runId: string;
  readonly settled: boolean;
  readonly problem: string | null;
}

/** Where a reply's run has got to, and what it said when it stopped. */
async function runStatus(
  runId: string,
): Promise<{ readonly status: string; readonly reason: string | null } | undefined> {
  try {
    const response = await fetch(`/api/editor/runs/${encodeURIComponent(runId)}`, {
      cache: "no-store",
    });
    if (!response.ok) return undefined;
    const body = (await response.json()) as {
      readonly run?: {
        readonly status?: unknown;
        readonly attempts?: readonly { readonly error?: unknown }[];
      };
    };
    if (typeof body.run?.status !== "string") return undefined;
    const failed = (body.run.attempts ?? []).flatMap((attempt) => {
      const said = describeFailure(attempt.error);
      return said === null ? [] : [said];
    });
    return { status: body.run.status, reason: failed.at(-1) ?? null };
  } catch {
    return undefined;
  }
}

/** The models this harness can call, for the picker beside the composer. */
async function configuredModels(): Promise<readonly ModelView[]> {
  try {
    const response = await fetch("/api/editor/models", { cache: "no-store" });
    if (!response.ok) return [];
    const body = (await response.json()) as { readonly models?: unknown };
    return Array.isArray(body.models) ? body.models.filter(isModelView) : [];
  } catch {
    return [];
  }
}

/**
 * A conversation's current branch, with a composer for the next user message.
 *
 * Messages are append-only in the runtime. Sending continues from the newest
 * message; when a workflow answers this conversation, sending also starts its
 * run, and the page reads the conversation again once that run settles.
 */
export function ConversationChat({ conversationId }: { readonly conversationId: string }) {
  const [conversation, setConversation] = useState<ConversationView | null>(null);
  const [messages, setMessages] = useState<readonly MessageView[]>([]);
  const [draft, setDraft] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const [version, setVersion] = useState(0);
  // The composer only appears once the conversation has loaded in the browser, so
  // reading the remembered choice here cannot disagree with the server render.
  const [choice, setChoice] = useState<ReplyChoice>(() => rememberedChoice(conversationId));
  const [workflows, setWorkflows] = useState<readonly WorkflowSummary[]>([]);
  const [models, setModels] = useState<readonly ModelView[] | null>(null);
  const [modelId, setModelId] = useState<string>(ANY_MODEL);
  const [reply, setReply] = useState<ReplyState | null>(null);

  useEffect(() => {
    void workspaceRequest<{ readonly workflows: readonly WorkflowSummary[] }>("workflows").then(
      (result) => {
        if (result.ok) setWorkflows(result.data.workflows);
      },
    );
    void configuredModels().then((configured) => {
      setModels(configured);
      setModelId(
        rememberedModel(
          conversationId,
          configured.map((model) => model.modelId),
        ),
      );
    });
  }, [conversationId]);

  // Follow a reply until its run settles, then show what it wrote.
  useEffect(() => {
    if (reply === null || reply.settled) return;
    let cancelled = false;
    const timer = window.setInterval(() => {
      void runStatus(reply.runId).then((run) => {
        if (cancelled || run === undefined || !runSettled(run.status)) return;
        setReply({
          runId: reply.runId,
          settled: true,
          problem: replyOutcome(run.status, run.reason),
        });
        setVersion((current) => current + 1);
      });
    }, 700);
    return () => {
      cancelled = true;
      window.clearInterval(timer);
    };
  }, [reply]);

  const answer = useCallback(
    async (workflow: WorkflowChoice): Promise<void> => {
      const started = await workspaceRequest<{ readonly runId: string }>(
        `conversations/${conversationId}/reply`,
        { workflow, ...(modelId === ANY_MODEL ? {} : { modelId }) },
      );
      if (!started.ok) {
        setError(started.reason);
        return;
      }
      setReply({ runId: started.data.runId, settled: false, problem: null });
    },
    [conversationId, modelId],
  );

  useEffect(() => {
    let cancelled = false;
    void loadConversation(conversationId).then((result) => {
      if (cancelled) return;
      if (result.ok) {
        setError(null);
        setConversation(result.conversation);
        setMessages(result.messages);
      } else {
        setError(result.reason);
      }
    });
    return () => {
      cancelled = true;
    };
  }, [conversationId, version]);

  const send = async (event: FormEvent<HTMLFormElement>): Promise<void> => {
    event.preventDefault();
    const text = draft.trim();
    if (text.length === 0) return;
    setBusy(true);
    const result = await workspaceRequest<unknown>(`conversations/${conversationId}/messages`, {
      role: "user",
      parts: [{ kind: "text", text }],
    });
    setBusy(false);
    if (!result.ok) {
      setError(result.reason);
      return;
    }
    setDraft("");
    setVersion((current) => current + 1);
    if (choice !== "none") await answer(choice);
  };

  if (conversation === null) {
    return (
      <div className="panel" role={error === null ? "status" : "alert"}>
        <p>{error ?? "Loading the conversation…"}</p>
      </div>
    );
  }

  const branch = latestBranch(messages);
  const hidden = messages.length - branch.length;
  const replying = reply !== null && !reply.settled;
  const lastRole = branch.at(-1)?.role;
  const unavailable = (id: string): boolean =>
    workflows.some((workflow) => workflow.id === id && !workflow.available);

  return (
    <>
      <div className="pageHeader">
        <h1 className="pageTitle">
          {conversation.title.length > 0 ? conversation.title : "Untitled conversation"}
        </h1>
        <Link className="btn" href={`/projects/${conversation.projectId}`}>
          Back to project
        </Link>
      </div>
      {hidden > 0 ? (
        <p className="muted small">
          Showing the latest branch; {hidden} earlier {hidden === 1 ? "message is" : "messages are"}{" "}
          on other branches.
        </p>
      ) : null}

      <div className="chatLog" aria-live="polite">
        {branch.length === 0 ? <p className="muted">No messages yet.</p> : null}
        {branch.map((message) => (
          <article
            key={message.messageId}
            className={`chatMessage chatMessage--${message.role}`}
            aria-label={`${message.role} message`}
          >
            <p className="eyebrow">
              {message.role}
              {message.model === null ? "" : ` · ${modelLabel(message.model)}`}
            </p>
            {message.parts.map((part, index) => (
              <Part key={index} part={part} />
            ))}
          </article>
        ))}
      </div>

      {replying ? (
        <p className="chatStatus" role="status">
          Thinking… <Link href={`/runs/${reply.runId}`}>watch the run</Link>
        </p>
      ) : null}
      {reply?.problem === null || reply?.problem === undefined ? null : (
        <p className="warn" role="alert">
          {reply.problem} <Link href={`/runs/${reply.runId}`}>See where it stopped</Link>
        </p>
      )}
      {error === null ? null : (
        <p className="field__error" role="alert">
          {error}
        </p>
      )}
      {choice !== "none" && models !== null && models.length === 0 ? (
        <p className="warn">
          No model is connected yet, so nothing can answer.{" "}
          <Link href="/models">Connect a model</Link>
        </p>
      ) : null}
      {conversation.status === "archived" ? (
        <p className="muted">This conversation is archived.</p>
      ) : (
        <form
          className="panel"
          aria-label="Send a message"
          onSubmit={(event) => {
            void send(event);
          }}
        >
          <label className="field">
            <span className="field__label">Message</span>
            <textarea
              className="field__input"
              rows={3}
              value={draft}
              onChange={(event) => {
                setDraft(event.target.value);
              }}
            />
          </label>
          <div className="chatControls">
            <label className="field chatAnswerer">
              <span className="field__label">Answered by</span>
              <select
                className="field__input"
                value={choice}
                onChange={(event) => {
                  const next = event.target.value;
                  if (!isReplyChoice(next)) return;
                  setChoice(next);
                  rememberChoice(conversationId, next);
                }}
              >
                {REPLY_CHOICES.map((option) => (
                  <option key={option.id} value={option.id} disabled={unavailable(option.id)}>
                    {option.label}
                  </option>
                ))}
              </select>
            </label>
            {choice === "none" || models === null || models.length === 0 ? null : (
              <label className="field chatAnswerer">
                <span className="field__label">Model</span>
                <select
                  className="field__input"
                  value={modelId}
                  onChange={(event) => {
                    setModelId(event.target.value);
                    rememberModel(conversationId, event.target.value);
                  }}
                >
                  <option value={ANY_MODEL}>Any model that can answer</option>
                  {models.map((model) => (
                    <option key={model.modelId} value={model.modelId}>
                      {model.title}
                    </option>
                  ))}
                </select>
              </label>
            )}
            {choice === "none" ? null : (
              <Link className="small" href={editorLink(choice, conversationId)}>
                Open this workflow in the editor
              </Link>
            )}
          </div>
          <div className="btnRow">
            <button
              className="btn btn--primary"
              type="submit"
              disabled={busy || replying || draft.trim().length === 0}
            >
              {busy ? "Sending…" : "Send"}
            </button>
            {choice !== "none" && lastRole === "user" && !replying ? (
              <button
                className="btn"
                type="button"
                onClick={() => {
                  setError(null);
                  void answer(choice);
                }}
              >
                Answer the last message
              </button>
            ) : null}
          </div>
        </form>
      )}
    </>
  );
}

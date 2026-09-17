"use client";

import Link from "next/link";
import { useEffect, useState, type FormEvent } from "react";

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

/**
 * A conversation's current branch, with a composer for the next user message.
 *
 * Messages are append-only in the runtime. Sending continues from the newest
 * message; agent runs append their replies and tool results to the same record.
 */
export function ConversationChat({ conversationId }: { readonly conversationId: string }) {
  const [conversation, setConversation] = useState<ConversationView | null>(null);
  const [messages, setMessages] = useState<readonly MessageView[]>([]);
  const [draft, setDraft] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const [version, setVersion] = useState(0);

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

      {error === null ? null : (
        <p className="field__error" role="alert">
          {error}
        </p>
      )}
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
          <div className="btnRow">
            <button
              className="btn btn--primary"
              type="submit"
              disabled={busy || draft.trim().length === 0}
            >
              {busy ? "Sending…" : "Send"}
            </button>
          </div>
        </form>
      )}
    </>
  );
}

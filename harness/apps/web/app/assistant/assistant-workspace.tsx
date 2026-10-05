"use client";
import { ChildChatScope } from "./child-chat-scope";
import Link from "next/link";
import { useCallback, useEffect, useRef, useState } from "react";
import { workspaceRequest } from "../../lib/workspace-client";
import {
  assistantAccess,
  type AssistantAccess,
  type AssistantPermission,
} from "./assistant-access-view";
type Value = Record<string, unknown>;
type Assistant = { assistantId: string; chatId: string; title: string; epoch: number };
type Chat = { id: string; title: string; status: string };
const object = (value: unknown): Value =>
  value && typeof value === "object" && !Array.isArray(value) ? (value as Value) : {};
const text = (value: unknown) => (typeof value === "string" ? value : "");
export function AssistantWorkspace({ initialAssistantId = "" }: { initialAssistantId?: string }) {
  const [assistants, setAssistants] = useState<Assistant[]>([]),
    [chats, setChats] = useState<Chat[]>([]),
    [assistantId, setAssistantId] = useState(initialAssistantId),
    [access, setAccess] = useState<AssistantAccess | null>(null),
    [candidate, setCandidate] = useState(""),
    [read, setRead] = useState(false),
    [control, setControl] = useState(false),
    [confirmed, setConfirmed] = useState(false),
    [busy, setBusy] = useState(false),
    [error, setError] = useState(""),
    [notice, setNotice] = useState("");
  const generation = useRef<number | null>(null);
  const action = useCallback(async (name: string, params: Value = {}) => {
    const expected = generation.current;
    const result = await workspaceRequest<{ result: unknown }>("assistant", {
      action: name,
      params,
    });
    if (expected !== null && generation.current !== expected)
      throw Error("Workspace changed. Select an assistant in this workspace.");
    if (!result.ok) throw Error(result.reason);
    return result.data.result;
  }, []);
  const acceptMetadata = useCallback((value: unknown) => {
    const data = object(value);
    if (
      !Array.isArray(data.assistants) ||
      !Array.isArray(data.chats) ||
      !Number.isSafeInteger(data.scopeGeneration)
    )
      throw Error("Assistant metadata is unavailable.");
    const next = Number(data.scopeGeneration);
    if (generation.current !== null && generation.current !== next) {
      setAssistantId("");
      setAccess(null);
      setCandidate("");
      setRead(false);
      setControl(false);
      setConfirmed(false);
      setNotice("");
    }
    generation.current = next;
    setAssistants(
      data.assistants
        .map((raw) => {
          const entry = object(raw);
          return {
            assistantId: text(entry.assistantId),
            chatId: text(entry.chatId),
            title: text(entry.title),
            epoch: Number(entry.epoch),
          };
        })
        .filter((item) => item.assistantId && item.chatId),
    );
    setChats(
      data.chats
        .map((raw) => {
          const entry = object(raw);
          return { id: text(entry.id), title: text(entry.title), status: text(entry.status) };
        })
        .filter((item) => item.id),
    );
  }, []);
  const reloadMetadata = useCallback(async () => {
    const result = await workspaceRequest<unknown>("assistant");
    if (!result.ok) throw Error(result.reason);
    acceptMetadata(result.data);
  }, [acceptMetadata]);
  useEffect(() => {
    let stale = false;
    let timer: ReturnType<typeof setTimeout>;
    async function poll() {
      const result = await workspaceRequest<unknown>("assistant");
      if (stale) return;
      try {
        if (!result.ok) throw Error(result.reason);
        acceptMetadata(result.data);
      } catch (cause) {
        setError(cause instanceof Error ? cause.message : "Assistant access is unavailable.");
      }
      timer = setTimeout(() => {
        void poll();
      }, 2000);
    }
    void poll();
    return () => {
      stale = true;
      clearTimeout(timer);
    };
  }, [acceptMetadata]);
  const reloadAccess = useCallback(async () => {
    if (!assistantId) return;
    const result = await action("read", { assistantId });
    const next = assistantAccess(result, assistantId);
    if (!next) throw Error("Assistant permissions could not be verified.");
    setAccess(next);
  }, [action, assistantId]);
  useEffect(() => {
    const url = new URL(window.location.href);
    if (assistantId) url.searchParams.set("assistant", assistantId);
    else url.searchParams.delete("assistant");
    window.history.replaceState(null, "", url);
    if (!assistantId) return;
    let stale = false;
    void action("read", { assistantId })
      .then((result) => {
        if (stale) return;
        const next = assistantAccess(result, assistantId);
        if (!next) throw Error("Assistant permissions could not be verified.");
        setAccess(next);
      })
      .catch((cause) => {
        if (!stale)
          setError(
            cause instanceof Error ? cause.message : "Assistant permissions are unavailable.",
          );
      });
    return () => {
      stale = true;
    };
  }, [action, assistantId]);
  useEffect(() => {
    const selected = assistants.find((item) => item.assistantId === assistantId);
    if (!selected || !access || selected.epoch === access.binding.epoch) return;
    let stale = false;
    void action("read", { assistantId })
      .then((result) => {
        if (stale) return;
        const next = assistantAccess(result, assistantId);
        setAccess(next ?? null);
      })
      .catch(() => {
        if (!stale) setAccess(null);
      });
    return () => {
      stale = true;
    };
  }, [action, assistants, assistantId, access]);
  async function run(work: () => Promise<void>) {
    setBusy(true);
    setError("");
    try {
      await work();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Assistant request failed.");
    } finally {
      setBusy(false);
    }
  }
  const selectedMetadata = assistants.find((item) => item.assistantId === assistantId);
  const current =
    access?.binding.assistantId === assistantId &&
    (!selectedMetadata || selectedMetadata.epoch === access.binding.epoch)
      ? access
      : null;
  const connectedGrants =
    current?.grants.filter((grant) => grant.chatId !== current.binding.actorChatId) ?? [];
  async function disconnect(chatId: string) {
    await action("disconnect", { assistantId, chatId });
    setAccess(null);
    setNotice(
      "Connection revoked. The runtime cancels affected work and rejects further access. Previously read information cannot be retroactively forgotten.",
    );
    await reloadAccess();
    await reloadMetadata();
  }
  const title = (id: string) => chats.find((chat) => chat.id === id)?.title || id;
  const permissions: AssistantPermission[] = [
    ...(read ? ["read" as const] : []),
    ...(control ? ["control" as const] : []),
  ];
  return (
    <>
      <section className="panel">
        <h2 className="panelTitle">Assistant</h2>
        <label>
          Saved assistant{" "}
          <select
            style={{ maxWidth: "100%" }}
            disabled={busy}
            value={assistantId}
            onChange={(event) => {
              setAssistantId(event.target.value);
              setAccess(null);
              setCandidate("");
              setConfirmed(false);
              setRead(false);
              setControl(false);
              setNotice("");
            }}
          >
            <option value="">Choose an assistant</option>
            {assistants.map((assistant) => (
              <option key={assistant.assistantId} value={assistant.assistantId}>
                {assistant.title || assistant.assistantId}
              </option>
            ))}
          </select>
        </label>{" "}
        <button
          disabled={busy}
          onClick={() => {
            void run(async () => {
              const result = object(await action("create"));
              const binding = object(result.binding);
              const id = text(binding.assistantId) || text(result.assistantId);
              if (!id) throw Error("Assistant creation did not return its identity.");
              await reloadMetadata();
              setAssistantId(id);
              setAccess(assistantAccess(result, id) ?? null);
            });
          }}
        >
          Create assistant with its own chat
        </button>
        <p className="muted">
          The list contains chat metadata only. Listing a chat does not authorize this assistant to
          read messages or control it.
        </p>
      </section>
      {error ? (
        <p role="alert" className="panel panel--warn">
          {error}
        </p>
      ) : null}
      {notice ? (
        <p role="status" className="panel">
          {notice}
        </p>
      ) : null}
      {current ? (
        <>
          <section className="panel" aria-label="Assistant authorization graph">
            <h2 className="panelTitle">Active authorization connections</h2>
            <p>
              Assistant epoch {current.binding.epoch}. Edges below are the actual current backend
              grants.
            </p>
            <p>
              <Link href={`/agent?session=${encodeURIComponent(current.binding.actorChatId)}`}>
                Open the assistant’s own chat
              </Link>
            </p>
            <div style={{ display: "grid", gap: 12, minWidth: 0 }}>
              <div className="card">
                <strong>Personal assistant</strong>
                <p>
                  <code style={{ overflowWrap: "anywhere" }}>{current.binding.actorChatId}</code>
                </p>
              </div>
              {connectedGrants.length ? (
                connectedGrants.map((grant) => (
                  <div
                    key={grant.chatId}
                    style={{ borderLeft: "3px solid currentColor", paddingLeft: 16, minWidth: 0 }}
                  >
                    <p aria-label={`Authorized edge to ${title(grant.chatId)}`}>
                      ↓ {grant.permissions.join(" + ")} authorization
                    </p>
                    <div className="card">
                      <strong>{title(grant.chatId)}</strong>
                      <p>
                        <code style={{ overflowWrap: "anywhere" }}>{grant.chatId}</code>
                      </p>
                      <p>
                        Read: {grant.permissions.includes("read") ? "allowed" : "denied"}. Control:{" "}
                        {grant.permissions.includes("control") ? "allowed" : "denied"}.
                      </p>
                      {grant.permissions.includes("read") ? (
                        <p>
                          <Link href={`/agent?session=${encodeURIComponent(grant.chatId)}`}>
                            Open connected chat
                          </Link>
                        </p>
                      ) : null}
                      <button
                        disabled={busy}
                        onClick={() => {
                          void run(() => disconnect(grant.chatId));
                        }}
                      >
                        Cut connection to {title(grant.chatId)}
                      </button>
                    </div>
                  </div>
                ))
              ) : (
                <p>No connected chats. Other chat messages and control remain denied.</p>
              )}
            </div>
            <p className="muted">
              Cutting an edge revokes backend authorization and cancels affected work. It does not
              erase information already seen. Reconnection requires a new explicit user approval;
              the model cannot grant itself access.
            </p>
            {current.notice ? <p>{current.notice}</p> : null}
          </section>
          <section className="panel">
            <h2 className="panelTitle">Connect an existing chat</h2>
            <label>
              Chat metadata{" "}
              <select
                style={{ maxWidth: "100%" }}
                value={candidate}
                disabled={busy}
                onChange={(event) => {
                  setCandidate(event.target.value);
                  setConfirmed(false);
                }}
              >
                <option value="">Choose a chat</option>
                {chats
                  .filter(
                    (chat) =>
                      chat.id !== current.binding.actorChatId &&
                      !current.grants.some((grant) => grant.chatId === chat.id),
                  )
                  .map((chat) => (
                    <option key={chat.id} value={chat.id}>
                      {chat.title || chat.id} ({chat.status})
                    </option>
                  ))}
              </select>
            </label>
            <p>
              <label>
                <input
                  type="checkbox"
                  checked={read}
                  disabled={busy}
                  onChange={(event) => {
                    setRead(event.target.checked);
                    setConfirmed(false);
                  }}
                />{" "}
                Read this chat’s messages
              </label>{" "}
              <label>
                <input
                  type="checkbox"
                  checked={control}
                  disabled={busy}
                  onChange={(event) => {
                    setControl(event.target.checked);
                    setConfirmed(false);
                  }}
                />{" "}
                Control this chat’s tasks within its granted permissions
              </label>
            </p>
            <label>
              <input
                type="checkbox"
                checked={confirmed}
                disabled={busy || !candidate || !permissions.length}
                onChange={(event) => setConfirmed(event.target.checked)}
              />{" "}
              I authorize this exact assistant/chat connection and the selected permissions.
            </label>{" "}
            <button
              disabled={busy || !candidate || !permissions.length || !confirmed}
              onClick={() => {
                void run(async () => {
                  await action("connect", {
                    assistantId,
                    chatId: candidate,
                    permissions,
                    confirm: true,
                  });
                  setConfirmed(false);
                  setCandidate("");
                  setRead(false);
                  setControl(false);
                  await reloadAccess();
                  await reloadMetadata();
                  setNotice("Connection authorized by your explicit action.");
                });
              }}
            >
              Connect selected chat
            </button>
          </section>
          <ChildChatScope
            key={`${assistantId}:${current.binding.epoch}`}
            grants={connectedGrants}
            busy={busy}
            create={async (grants, title) => {
              await run(async () => {
                await action("child/create", { assistantId, grants, ...(title ? { title } : {}) });
                await reloadAccess();
                await reloadMetadata();
                setNotice("Child chat created with the selected inherited permission subset.");
              });
            }}
          />
        </>
      ) : (
        <section className="panel">
          <p>
            {assistantId
              ? "Loading verified assistant permissions…"
              : "Create or select an assistant to manage its connections."}
          </p>
        </section>
      )}
    </>
  );
}

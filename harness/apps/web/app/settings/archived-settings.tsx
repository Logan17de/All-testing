"use client";

import { useEffect, useRef, useState } from "react";
import { workspaceRequest } from "../../lib/workspace-client";
import { useAppNavigation } from "../app-shell";
import {
  archivedChats,
  confirmedChatDeletion,
  retentionDays,
  savedRetentionDays,
  type ArchivedChat,
} from "./archived-chat-settings";
import "./archived-settings.css";

export function ArchivedSettings() {
  const { refreshSessions } = useAppNavigation();
  const [chats, setChats] = useState<ArchivedChat[]>([]);
  const [query, setQuery] = useState("");
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState("");
  const [retentionError, setRetentionError] = useState("");
  const [operationError, setOperationError] = useState("");
  const [message, setMessage] = useState("");
  const [busyId, setBusyId] = useState<string | null>(null);
  const [savedDays, setSavedDays] = useState<number | null>(null);
  const [daysInput, setDaysInput] = useState("-1");
  const [deleteChat, setDeleteChat] = useState<ArchivedChat | null>(null);
  const [pendingDays, setPendingDays] = useState<number | null>(null);
  const [loadVersion, setLoadVersion] = useState(0);
  const mounted = useRef(false);
  const mutationBusy = useRef(false);
  const searchInput = useRef<HTMLInputElement>(null);
  const retentionInput = useRef<HTMLInputElement>(null);
  const deleteTrigger = useRef<HTMLButtonElement | null>(null);
  const deleteCancel = useRef<HTMLButtonElement>(null);
  const retentionCancel = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  useEffect(() => {
    let cancelled = false;
    void workspaceRequest<{ result: unknown }>("agent", {
      action: "session/list",
      params: { archived: true },
    }).then((response) => {
      if (cancelled) return;
      if (!response.ok) setLoadError(response.reason);
      else {
        const data = archivedChats(response.data.result);
        if (data === null) setLoadError("The archived chat list could not be read. Please retry.");
        else {
          setChats(data);
          setLoadError("");
        }
      }
      setLoading(false);
    });
    void workspaceRequest<{ result: unknown }>("agent", {
      action: "session/retention/read",
      params: {},
    }).then((response) => {
      if (cancelled) return;
      if (!response.ok) setRetentionError(response.reason);
      else {
        const days = savedRetentionDays(response.data.result);
        if (days === null)
          setRetentionError("The retention setting could not be read. Please retry.");
        else {
          setSavedDays(days);
          setDaysInput(String(days));
          setRetentionError("");
        }
      }
    });
    return () => {
      cancelled = true;
    };
  }, [loadVersion]);
  useEffect(() => {
    if (deleteChat) deleteCancel.current?.focus();
  }, [deleteChat]);
  useEffect(() => {
    if (pendingDays !== null) retentionCancel.current?.focus();
  }, [pendingDays]);

  function reload() {
    setLoadError("");
    setRetentionError("");
    setLoading(true);
    setLoadVersion((version) => version + 1);
  }
  function cancelDelete() {
    if (mutationBusy.current) return;
    setDeleteChat(null);
    setOperationError("");
    deleteTrigger.current?.focus();
  }
  function cancelRetention() {
    if (mutationBusy.current) return;
    setPendingDays(null);
    retentionInput.current?.focus();
  }
  async function changeChat(chat: ArchivedChat, action: "session/restore" | "session/delete") {
    if (mutationBusy.current || loading) return;
    mutationBusy.current = true;
    setBusyId(chat.id);
    setOperationError("");
    setMessage("");
    const response = await workspaceRequest<{ result: unknown }>("agent", {
      action,
      params: { sessionId: chat.id },
    });
    const failure = !response.ok
      ? response.reason
      : action === "session/delete" && !confirmedChatDeletion(response.data.result, chat.id)
        ? "The deletion could not be confirmed. Refresh the archived chat list before retrying."
        : null;
    if (failure === null) {
      refreshSessions();
      if (action === "session/delete")
        window.dispatchEvent(
          new CustomEvent("zet:session-deleted", { detail: { sessionId: chat.id } }),
        );
    }
    if (mounted.current) {
      if (failure === null) {
        setChats((current) => current.filter((item) => item.id !== chat.id));
        setMessage(
          `${action === "session/delete" ? "Permanently deleted" : "Restored"} “${chat.title || "Untitled chat"}”.`,
        );
        setDeleteChat(null);
        searchInput.current?.focus();
      } else setOperationError(failure);
      setBusyId(null);
    }
    mutationBusy.current = false;
  }
  async function saveRetention(days: number) {
    if (mutationBusy.current || savedDays === null) return;
    mutationBusy.current = true;
    setBusyId("retention");
    setRetentionError("");
    setMessage("");
    const response = await workspaceRequest<{ result: unknown }>("agent", {
      action: "session/retention/update",
      params: { days },
    });
    if (mounted.current) {
      const accepted = response.ok ? savedRetentionDays(response.data.result) : null;
      if (!response.ok) setRetentionError(response.reason);
      else if (accepted !== days)
        setRetentionError(
          "The retention change could not be confirmed. Retry to read the saved setting.",
        );
      else {
        setSavedDays(days);
        setDaysInput(String(days));
        setPendingDays(null);
        setMessage(
          days === -1
            ? "Automatic deletion is off. Archived chats are kept until you delete them."
            : `Archived chats will be permanently deleted ${days} ${days === 1 ? "day" : "days"} after archiving.`,
        );
        refreshSessions();
        setLoading(true);
        setLoadVersion((version) => version + 1);
        retentionInput.current?.focus();
      }
      setBusyId(null);
    }
    mutationBusy.current = false;
  }

  const filtered = chats.filter((chat) =>
    chat.title.toLocaleLowerCase().includes(query.trim().toLocaleLowerCase()),
  );
  const parsedDays = retentionDays(daysInput);
  const changedDays = parsedDays !== savedDays;
  const busy = busyId !== null;
  return (
    <div className="archivedSettings">
      <section className="archivedRetention" aria-labelledby="archived-retention-title">
        <h3 id="archived-retention-title">Automatically delete archived chats</h3>
        <p id="archived-retention-help">
          Enter the number of days to keep a chat after archiving. Use <strong>-1</strong> to never
          delete automatically.
        </p>
        <form
          onSubmit={(event) => {
            event.preventDefault();
            if (parsedDays === null || !changedDays || busy || savedDays === null || retentionError)
              return;
            setDeleteChat(null);
            if (parsedDays === -1) void saveRetention(-1);
            else setPendingDays(parsedDays);
          }}
        >
          <label htmlFor="archived-retention-days">Days after archiving</label>
          <div className="archivedRetentionControls">
            <input
              ref={retentionInput}
              id="archived-retention-days"
              type="number"
              min="-1"
              step="1"
              value={daysInput}
              disabled={busy || savedDays === null}
              aria-describedby="archived-retention-help archived-retention-saved"
              aria-invalid={parsedDays === null}
              onChange={(event) => {
                setDaysInput(event.target.value);
                setPendingDays(null);
              }}
            />
            <button
              type="submit"
              disabled={
                busy ||
                savedDays === null ||
                parsedDays === null ||
                !changedDays ||
                Boolean(retentionError)
              }
            >
              {busyId === "retention" ? "Saving…" : "Save retention"}
            </button>
          </div>
          {parsedDays === null ? (
            <p className="archivedSettingsError" role="alert">
              Enter -1 for never, or a whole number of days greater than zero.
            </p>
          ) : null}
        </form>
        <p id="archived-retention-saved" className="archivedSettingsFootnote">
          {savedDays === null
            ? retentionError
              ? "Retention setting unavailable."
              : "Loading retention setting…"
            : savedDays === -1
              ? "Current setting: never delete automatically."
              : `Current setting: delete after ${savedDays} ${savedDays === 1 ? "day" : "days"}.`}
        </p>
        {pendingDays !== null ? (
          <div
            className="archivedConfirmation"
            role="group"
            aria-label="Review automatic deletion"
            onKeyDown={(event) => {
              if (event.key === "Escape") {
                event.preventDefault();
                event.stopPropagation();
                cancelRetention();
              }
            }}
          >
            <p>
              Permanently delete archived chats after{" "}
              <strong>
                {pendingDays} {pendingDays === 1 ? "day" : "days"}
              </strong>
              ?
            </p>
            <p>This includes chats already older than this limit. Deletion cannot be undone.</p>
            <div className="archivedConfirmationActions">
              <button ref={retentionCancel} type="button" disabled={busy} onClick={cancelRetention}>
                Cancel
              </button>
              <button
                className="archivedSettingsDanger"
                type="button"
                disabled={busy}
                onClick={() => {
                  void saveRetention(pendingDays);
                }}
              >
                {busyId === "retention" ? "Saving…" : "Save and apply auto-delete"}
              </button>
            </div>
          </div>
        ) : null}
        {retentionError ? (
          <div className="archivedSettingsError" role="alert">
            <p>{retentionError}</p>
            <button type="button" disabled={busy || loading} onClick={reload}>
              Retry retention
            </button>
          </div>
        ) : null}
        <p className="archivedSettingsFootnote">
          Cleanup runs while the harness is open and when it starts. Chats with unfinished work wait
          until it finishes. Restoring a chat stops its deletion countdown.
        </p>
      </section>
      <label className="archivedSettingsSearch">
        <span className="archivedSettingsSearchLabel">Search archived chats</span>
        <svg aria-hidden="true" viewBox="0 0 16 16" fill="none">
          <circle cx="7" cy="7" r="4.5" />
          <path d="m10.5 10.5 3 3" />
        </svg>
        <input
          ref={searchInput}
          type="search"
          placeholder="Search archived chats"
          value={query}
          onChange={(event) => setQuery(event.target.value)}
        />
      </label>
      {loading ? (
        <p className="archivedSettingsMessage" role="status">
          Loading archived chats…
        </p>
      ) : null}
      {loadError ? (
        <div className="archivedSettingsError" role="alert">
          <p>{loadError}</p>
          <button type="button" disabled={loading || busy} onClick={reload}>
            Retry
          </button>
        </div>
      ) : null}
      {operationError ? (
        <div className="archivedSettingsError" role="alert">
          <p>{operationError}</p>
          <button
            type="button"
            disabled={busy || loading}
            onClick={() => {
              setOperationError("");
              setDeleteChat(null);
              reload();
            }}
          >
            Refresh archived chats
          </button>
        </div>
      ) : null}
      {message ? (
        <p className="archivedSettingsMessage" role="status">
          {message}
        </p>
      ) : null}
      {!loading && !loadError && !filtered.length ? (
        <p className="archivedSettingsMessage" role="status">
          {query.trim() ? "No archived chats match your search." : "No archived chats."}
        </p>
      ) : null}
      {!loading && !loadError && filtered.length ? (
        <ul className="archivedSettingsList" aria-label="Archived chats" aria-busy={busy}>
          {filtered.map((chat) => (
            <li key={chat.id}>
              <div className="archivedSettingsRow">
                <svg
                  className="archivedSettingsChatIcon"
                  aria-hidden="true"
                  viewBox="0 0 16 16"
                  fill="none"
                >
                  <path d="M13.5 7.5a5.5 5.5 0 0 1-5.5 5.5H2.5l1-3A5.5 5.5 0 1 1 13.5 7.5Z" />
                </svg>
                <div className="archivedSettingsChatInfo">
                  <span className="archivedSettingsTitle" title={chat.title}>
                    {chat.title || "Untitled chat"}
                  </span>
                  {chat.archivedAt !== undefined ? (
                    <span className="archivedSettingsDate">
                      Archived {new Date(chat.archivedAt).toLocaleDateString()}
                    </span>
                  ) : null}
                </div>
                <div className="archivedSettingsActions">
                  <button
                    type="button"
                    disabled={busy}
                    aria-label={`Restore ${chat.title || "Untitled chat"}`}
                    onClick={() => {
                      void changeChat(chat, "session/restore");
                    }}
                  >
                    {busyId === chat.id && deleteChat?.id !== chat.id ? "Restoring…" : "Restore"}
                  </button>
                  <button
                    type="button"
                    className="archivedSettingsDanger"
                    disabled={busy}
                    aria-label={`Delete ${chat.title || "Untitled chat"} permanently`}
                    onClick={(event) => {
                      deleteTrigger.current = event.currentTarget;
                      setPendingDays(null);
                      setDeleteChat(chat);
                      setOperationError("");
                    }}
                  >
                    Delete permanently
                  </button>
                </div>
              </div>
              {deleteChat?.id === chat.id ? (
                <div
                  className="archivedConfirmation"
                  role="group"
                  aria-label={`Delete ${chat.title || "Untitled chat"} permanently`}
                  onKeyDown={(event) => {
                    if (event.key === "Escape") {
                      event.preventDefault();
                      event.stopPropagation();
                      cancelDelete();
                    }
                  }}
                >
                  <p>
                    Delete “<strong>{chat.title || "Untitled chat"}</strong>” permanently?
                  </p>
                  <p>This deletes the chat and its saved history. It cannot be restored.</p>
                  <div className="archivedConfirmationActions">
                    <button ref={deleteCancel} type="button" disabled={busy} onClick={cancelDelete}>
                      Cancel
                    </button>
                    <button
                      type="button"
                      className="archivedSettingsDanger"
                      disabled={busy}
                      onClick={() => {
                        void changeChat(chat, "session/delete");
                      }}
                    >
                      {busyId === chat.id ? "Deleting…" : "Delete chat permanently"}
                    </button>
                  </div>
                </div>
              ) : null}
            </li>
          ))}
        </ul>
      ) : null}
      <p className="archivedSettingsFootnote">
        Restoring a chat returns it to your chat list with its history intact.
      </p>
    </div>
  );
}

"use client";

import { useEffect, useState, type FormEvent } from "react";

import {
  MEMORY_BODY_MAX_LENGTH,
  MEMORY_KINDS,
  MEMORY_TITLE_MAX_LENGTH,
  NO_MEMORY_FILTER,
  changeMemory,
  forgetMemory,
  listMemories,
  rememberMemory,
  type MemoryDraft,
  type MemoryFilter,
  type MemoryKind,
  type MemoryView,
} from "../../../lib/memory-client";
import type { WorkspaceResult } from "../../../lib/workspace-client";

const EMPTY_DRAFT: MemoryDraft = { title: "", body: "", kind: "note" };

function filtering(filter: MemoryFilter): boolean {
  return filter.search.trim().length > 0 || filter.kind !== "" || filter.pinnedOnly;
}

function writtenBy(memory: MemoryView): string {
  return memory.source === "agent" ? "Written by a run" : "Written by a person";
}

/**
 * What a project remembers, and a person's hand on it.
 *
 * An agent step is offered these memories inside its context budget, pinned first
 * and then most recently changed, so this panel lists them in the same order: what
 * a reader sees at the top is what a step is most likely to be told. Forgetting
 * removes a memory outright rather than archiving it, which is why it asks first.
 */
export function MemoryPanel({
  projectId,
  archived,
}: {
  readonly projectId: string;
  readonly archived: boolean;
}) {
  const [memories, setMemories] = useState<readonly MemoryView[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [filter, setFilter] = useState<MemoryFilter>(NO_MEMORY_FILTER);
  const [searchDraft, setSearchDraft] = useState("");
  const [draft, setDraft] = useState<MemoryDraft>(EMPTY_DRAFT);
  const [editing, setEditing] = useState<(MemoryDraft & { readonly memoryId: string }) | null>(
    null,
  );
  const [forgetting, setForgetting] = useState<string | null>(null);
  const [version, setVersion] = useState(0);

  useEffect(() => {
    let cancelled = false;
    void listMemories(projectId, filter).then((result) => {
      if (cancelled) return;
      if (result.ok) {
        setError(null);
        setMemories(result.data);
      } else {
        setError(result.reason);
        setMemories([]);
      }
    });
    return () => {
      cancelled = true;
    };
  }, [projectId, filter, version]);

  const applied = (result: WorkspaceResult<unknown>): boolean => {
    setBusy(false);
    if (!result.ok) {
      setError(result.reason);
      return false;
    }
    setError(null);
    setVersion((current) => current + 1);
    return true;
  };

  const write = async (event: FormEvent<HTMLFormElement>): Promise<void> => {
    event.preventDefault();
    setBusy(true);
    if (applied(await rememberMemory(projectId, draft))) setDraft(EMPTY_DRAFT);
  };

  const save = async (event: FormEvent<HTMLFormElement>): Promise<void> => {
    event.preventDefault();
    if (editing === null) return;
    setBusy(true);
    const saved = await changeMemory(editing.memoryId, {
      title: editing.title,
      body: editing.body,
      kind: editing.kind,
    });
    if (applied(saved)) setEditing(null);
  };

  const pin = async (memory: MemoryView): Promise<void> => {
    setBusy(true);
    applied(await changeMemory(memory.memoryId, { pinned: !memory.pinned }));
  };

  const forget = async (memoryId: string): Promise<void> => {
    setBusy(true);
    if (applied(await forgetMemory(memoryId))) setForgetting(null);
  };

  return (
    <section className="panel" aria-label="Memory">
      <h2 className="panelTitle">What this project remembers</h2>
      <p className="muted small">
        An agent step is offered these inside its context budget, pinned first, then most recently
        changed.
      </p>
      {error === null ? null : (
        <p className="field__error" role="alert">
          {error}
        </p>
      )}

      <form
        className="memoryFilters"
        aria-label="Search memories"
        onSubmit={(event) => {
          event.preventDefault();
          setFilter({ ...filter, search: searchDraft });
        }}
      >
        <label className="field">
          <span className="field__label">Search</span>
          <input
            className="field__input"
            value={searchDraft}
            maxLength={MEMORY_TITLE_MAX_LENGTH}
            placeholder="Any word in a memory"
            onChange={(event) => {
              setSearchDraft(event.target.value);
            }}
          />
        </label>
        <label className="field">
          <span className="field__label">Kind</span>
          <select
            className="field__input"
            value={filter.kind}
            onChange={(event) => {
              setFilter({ ...filter, kind: event.target.value as MemoryKind | "" });
            }}
          >
            <option value="">Any kind</option>
            {MEMORY_KINDS.map((kind) => (
              <option key={kind} value={kind}>
                {kind}
              </option>
            ))}
          </select>
        </label>
        <label className="field__check">
          <input
            type="checkbox"
            checked={filter.pinnedOnly}
            onChange={(event) => {
              setFilter({ ...filter, pinnedOnly: event.target.checked });
            }}
          />
          Pinned only
        </label>
        <button className="btn" type="submit" disabled={busy}>
          Search
        </button>
      </form>

      {memories === null ? (
        <p className="muted" role="status">
          Reading what this project remembers…
        </p>
      ) : memories.length === 0 ? (
        <p className="muted">
          {filtering(filter) ? "Nothing remembered matches that." : "Nothing remembered yet."}
        </p>
      ) : (
        <ul className="todoList">
          {memories.map((memory) => (
            <li className="todoItem" key={memory.memoryId} aria-label={`Memory ${memory.title}`}>
              <div className="cardHead">
                <strong>{memory.title}</strong>
                <span className="chips">
                  {memory.pinned ? <span className="chip">pinned</span> : null}
                  <span className="chip">{memory.kind}</span>
                </span>
              </div>
              <p className="memoryText">{memory.body}</p>
              <span className="muted small">
                {writtenBy(memory)} · updated {new Date(memory.updatedAtMs).toLocaleString()}
              </span>

              {archived || editing?.memoryId === memory.memoryId ? null : (
                <div className="btnRow">
                  <button
                    className="btn"
                    type="button"
                    disabled={busy}
                    onClick={() => {
                      void pin(memory);
                    }}
                  >
                    {memory.pinned ? "Unpin" : "Pin"}
                  </button>
                  <button
                    className="btn"
                    type="button"
                    disabled={busy}
                    onClick={() => {
                      setForgetting(null);
                      setEditing({
                        memoryId: memory.memoryId,
                        title: memory.title,
                        body: memory.body,
                        kind: memory.kind,
                      });
                    }}
                  >
                    Edit…
                  </button>
                  <button
                    className="btn btn--danger"
                    type="button"
                    disabled={busy}
                    onClick={() => {
                      setForgetting(memory.memoryId);
                    }}
                  >
                    Forget…
                  </button>
                </div>
              )}

              {editing?.memoryId === memory.memoryId ? (
                <form
                  aria-label={`Edit ${memory.title}`}
                  onSubmit={(event) => {
                    void save(event);
                  }}
                >
                  <label className="field">
                    <span className="field__label">Title</span>
                    <input
                      className="field__input"
                      value={editing.title}
                      maxLength={MEMORY_TITLE_MAX_LENGTH}
                      required
                      onChange={(event) => {
                        setEditing({ ...editing, title: event.target.value });
                      }}
                    />
                  </label>
                  <label className="field">
                    <span className="field__label">What to remember</span>
                    <textarea
                      className="field__input"
                      value={editing.body}
                      maxLength={MEMORY_BODY_MAX_LENGTH}
                      rows={3}
                      required
                      onChange={(event) => {
                        setEditing({ ...editing, body: event.target.value });
                      }}
                    />
                  </label>
                  <label className="field">
                    <span className="field__label">Kind</span>
                    <select
                      className="field__input"
                      value={editing.kind}
                      onChange={(event) => {
                        setEditing({ ...editing, kind: event.target.value as MemoryKind });
                      }}
                    >
                      {MEMORY_KINDS.map((kind) => (
                        <option key={kind} value={kind}>
                          {kind}
                        </option>
                      ))}
                    </select>
                  </label>
                  <div className="btnRow">
                    <button
                      className="btn btn--primary"
                      type="submit"
                      disabled={
                        busy ||
                        editing.title.trim().length === 0 ||
                        editing.body.trim().length === 0
                      }
                    >
                      Save
                    </button>
                    <button
                      className="btn"
                      type="button"
                      onClick={() => {
                        setEditing(null);
                      }}
                    >
                      Cancel
                    </button>
                  </div>
                </form>
              ) : null}

              {forgetting === memory.memoryId ? (
                <div className="btnRow" role="group" aria-label={`Forget ${memory.title}`}>
                  <span className="muted small">Forgetting removes it; nothing keeps a copy.</span>
                  <button
                    className="btn btn--danger"
                    type="button"
                    disabled={busy}
                    onClick={() => {
                      void forget(memory.memoryId);
                    }}
                  >
                    Forget it
                  </button>
                  <button
                    className="btn"
                    type="button"
                    onClick={() => {
                      setForgetting(null);
                    }}
                  >
                    Keep it
                  </button>
                </div>
              ) : null}
            </li>
          ))}
        </ul>
      )}

      {archived ? (
        <p className="muted small">
          An archived project keeps its memories but writes no new ones.
        </p>
      ) : (
        <form
          aria-label="New memory"
          onSubmit={(event) => {
            void write(event);
          }}
        >
          <label className="field">
            <span className="field__label">Remember something</span>
            <input
              className="field__input"
              value={draft.title}
              maxLength={MEMORY_TITLE_MAX_LENGTH}
              placeholder="Title"
              onChange={(event) => {
                setDraft({ ...draft, title: event.target.value });
              }}
            />
          </label>
          <label className="field">
            <span className="field__label">What to remember</span>
            <textarea
              className="field__input"
              value={draft.body}
              maxLength={MEMORY_BODY_MAX_LENGTH}
              rows={3}
              onChange={(event) => {
                setDraft({ ...draft, body: event.target.value });
              }}
            />
          </label>
          <label className="field">
            <span className="field__label">Kind</span>
            <select
              className="field__input"
              value={draft.kind}
              onChange={(event) => {
                setDraft({ ...draft, kind: event.target.value as MemoryKind });
              }}
            >
              {MEMORY_KINDS.map((kind) => (
                <option key={kind} value={kind}>
                  {kind}
                </option>
              ))}
            </select>
          </label>
          <div className="btnRow">
            <button
              className="btn btn--primary"
              type="submit"
              disabled={busy || draft.title.trim().length === 0 || draft.body.trim().length === 0}
            >
              Remember it
            </button>
          </div>
        </form>
      )}
    </section>
  );
}

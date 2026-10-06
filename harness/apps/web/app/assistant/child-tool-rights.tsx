"use client";
import { useEffect, useRef, useState } from "react";
import { workspaceRequest } from "../../lib/workspace-client";
import { childToolRights, type ToolRights as Rights } from "./child-tool-rights-view";
export function ChildToolRights({ assistantId }: { assistantId: string }) {
  const [rights, setRights] = useState<Rights | null>(null),
    [actorId, setActorId] = useState(""),
    [model, setModel] = useState<string[]>([]),
    [tools, setTools] = useState<string[]>([]),
    [confirmed, setConfirmed] = useState(false),
    [busy, setBusy] = useState(false),
    [error, setError] = useState("");
  const epoch = useRef<number | null>(null);
  async function request(action: string, params: Record<string, unknown> = {}) {
    const response = await workspaceRequest<{ result: unknown }>("assistant", {
      action,
      params: { assistantId, ...params },
    });
    if (!response.ok) throw Error(response.reason);
    return response.data.result;
  }
  async function refresh() {
    const result = childToolRights(await request("tools/read"));
    if (!result) throw Error("Tool rights could not be verified.");
    setRights(result);
  }
  useEffect(() => {
    let disposed = false;
    async function poll() {
      try {
        const response = await workspaceRequest<{ result: Rights }>("assistant", {
          action: "tools/read",
          params: { assistantId },
        });
        if (disposed) return;
        if (!response.ok) throw Error(response.reason);
        const data = childToolRights(response.data.result);
        if (!data) throw Error("Tool rights could not be verified.");
        if (epoch.current !== null && epoch.current !== data.epoch) setConfirmed(false);
        epoch.current = data.epoch;
        setRights(data);
      } catch (cause) {
        if (!disposed) {
          setRights(null);
          setError(cause instanceof Error ? cause.message : "Tool rights unavailable.");
        }
      }
    }
    void poll();
    const timer = setInterval(() => {
      void poll();
    }, 2000);
    return () => {
      disposed = true;
      clearInterval(timer);
    };
  }, [assistantId]);
  async function perform(action: string, params: Record<string, unknown>) {
    setBusy(true);
    setError("");
    try {
      if (!rights) throw Error("Refresh verified rights before making a decision.");
      await request(action, { ...params, epoch: rights.epoch });
      setConfirmed(false);
      await refresh();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Tool permission request failed.");
    } finally {
      setBusy(false);
    }
  }
  const actor = rights?.actors.find((item) => item.chatId === actorId);
  return (
    <section className="panel">
      <h2 className="panelTitle">Child tool permissions</h2>
      <p>
        Choose tools already granted by you. Delegation never enables a host capability or bypasses
        per-action approvals. Changing rights cuts affected active work; the updated scope applies
        to a fresh turn.
      </p>
      {error ? <p role="alert">{error}</p> : null}
      {rights ? (
        <>
          <label>
            Agent{" "}
            <select
              style={{ maxWidth: "100%" }}
              value={actorId}
              disabled={busy}
              onChange={(e) => {
                setActorId(e.target.value);
                setModel([]);
                setTools([]);
                setConfirmed(false);
              }}
            >
              <option value="">Choose an agent</option>
              {rights.actors.map((item) => (
                <option key={item.chatId} value={item.chatId}>
                  {item.parentChatId ? "Child" : "Parent"}: {item.chatId}
                </option>
              ))}
            </select>
          </label>
          {actor ? (
            <>
              <p style={{ overflowWrap: "anywhere" }}>
                Current model tools: {actor.scopes.model?.join(", ") ?? "all host-granted tools"}.
                Current execution tools:{" "}
                {actor.scopes.tools?.join(", ") ?? "all host-granted tools"}.
              </p>
              <p style={{ overflowWrap: "anywhere" }}>
                Delegation ceiling:{" "}
                {actor.delegationCeiling
                  ? JSON.stringify(actor.delegationCeiling)
                  : "none established"}
                .
              </p>
              <p>
                Unchecked tools are excluded from this assignment. An empty selection permits no
                tools.
              </p>
              <div
                style={{
                  display: "grid",
                  gridTemplateColumns: "repeat(auto-fit,minmax(min(100%,240px),1fr))",
                  gap: 12,
                }}
              >
                {(["model", "tools"] as const).map((kind) => (
                  <fieldset key={kind} disabled={busy}>
                    <legend>
                      {kind === "model" ? "Tools offered to the model" : "Tools allowed to execute"}
                    </legend>
                    {rights.catalog.map((id) => (
                      <label key={id} style={{ display: "block", overflowWrap: "anywhere" }}>
                        <input
                          type="checkbox"
                          checked={(kind === "model" ? model : tools).includes(id)}
                          onChange={(e) => {
                            const setter = kind === "model" ? setModel : setTools;
                            setter((previous) =>
                              e.target.checked
                                ? [...previous, id]
                                : previous.filter((value) => value !== id),
                            );
                            setConfirmed(false);
                          }}
                        />{" "}
                        {id}
                      </label>
                    ))}
                  </fieldset>
                ))}
              </div>
              <label>
                <input
                  type="checkbox"
                  checked={confirmed}
                  disabled={busy}
                  onChange={(e) => setConfirmed(e.target.checked)}
                />{" "}
                I authorize this exact tool selection and cancellation of affected active work.
              </label>
              <div className="btnRow">
                <button
                  disabled={busy || !confirmed}
                  onClick={() => {
                    void perform("tools/authority", {
                      actorChatId: actorId,
                      scopes: { model, tools },
                      confirm: true,
                    });
                  }}
                >
                  Set delegated ceiling
                </button>
                {actor.parentChatId ? (
                  <button
                    disabled={busy || !confirmed}
                    onClick={() => {
                      void perform("child/tools", {
                        chatId: actorId,
                        scopes: { model, tools },
                        confirm: true,
                      });
                    }}
                  >
                    Assign child tools
                  </button>
                ) : null}
              </div>
            </>
          ) : null}
          <h3>Tool requests and decisions</h3>
          {rights.requests.length ? (
            rights.requests.map((item) => (
              <article className="card" key={item.id}>
                <p style={{ overflowWrap: "anywhere" }}>
                  Child {item.childChatId} → parent {item.parentChatId}
                </p>
                <p>
                  Status: {item.status}.{" "}
                  {item.requiresUser
                    ? "Explicit user review required; parent authority does not cover this request."
                    : "Within delegated parent authority."}
                </p>
                <pre style={{ whiteSpace: "pre-wrap", overflowWrap: "anywhere" }}>
                  {JSON.stringify(item.scopes, null, 2)}
                </pre>
                {item.status === "pending" ? (
                  <RequestDecision
                    key={`${item.id}:${item.epoch}`}
                    busy={busy}
                    decide={(decision) =>
                      perform("tools/decide", { requestId: item.id, decision, confirm: true })
                    }
                  />
                ) : null}
              </article>
            ))
          ) : (
            <p>
              No tool requests. A child can request more tools; its parent may grant only within the
              authority you delegated.
            </p>
          )}
          <details>
            <summary>Permission audit</summary>
            {rights.audit.length ? (
              <ol>
                {rights.audit.map((item) => (
                  <li key={item.sequence}>
                    {item.action} · epoch {item.epoch}
                    <pre style={{ whiteSpace: "pre-wrap", overflowWrap: "anywhere" }}>
                      {JSON.stringify(item.details, null, 2)}
                    </pre>
                  </li>
                ))}
              </ol>
            ) : (
              <p>No recorded permission changes.</p>
            )}
          </details>
        </>
      ) : (
        <p>Loading verified tool rights…</p>
      )}
    </section>
  );
}
function RequestDecision({
  busy,
  decide,
}: {
  busy: boolean;
  decide: (decision: "grant" | "deny") => Promise<void>;
}) {
  const [confirmed, setConfirmed] = useState(false);
  return (
    <>
      <label>
        <input
          type="checkbox"
          checked={confirmed}
          disabled={busy}
          onChange={(event) => setConfirmed(event.target.checked)}
        />{" "}
        I approve the exact requested scopes shown above.
      </label>
      <div className="btnRow">
        <button
          disabled={busy || !confirmed}
          onClick={() => {
            void decide("grant");
          }}
        >
          Grant requested tools
        </button>
        <button
          disabled={busy}
          onClick={() => {
            void decide("deny");
          }}
        >
          Deny request
        </button>
      </div>
    </>
  );
}

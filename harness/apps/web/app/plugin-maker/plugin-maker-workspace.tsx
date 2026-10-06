"use client";
import Link from "next/link";
import { useEffect, useRef, useState } from "react";
import { workspaceRequest } from "../../lib/workspace-client";
import { hasExecutedSandboxTests, pluginDraft, type PluginDraft } from "./plugin-maker-view";
export function PluginMakerWorkspace() {
  const generation = useRef<number | null>(null);
  const artifactHash = useRef("");
  const [ready, setReady] = useState(false),
    [materializedKey, setMaterializedKey] = useState(""),
    [directory, setDirectory] = useState(""),
    [confirmed, setConfirmed] = useState(false),
    [executionConsent, setExecutionConsent] = useState(false),
    [snapshot, setSnapshot] = useState<Record<string, unknown>>({});
  const [id, setId] = useState(""),
    [name, setName] = useState(""),
    [description, setDescription] = useState(""),
    [draft, setDraft] = useState<PluginDraft | null>(null),
    [path, setPath] = useState(""),
    [content, setContent] = useState(""),
    [report, setReport] = useState<unknown>(null),
    [busy, setBusy] = useState(false),
    [error, setError] = useState("");
  async function action(action: string, params: Record<string, unknown>) {
    if (!ready) {
      setError("Wait for the scoped plugin maker runtime.");
      return;
    }
    const expected = generation.current;
    setBusy(true);
    setError("");
    try {
      const response = await workspaceRequest<{ result: unknown }>("plugin-maker", {
        action,
        params,
      });
      if (generation.current !== expected)
        throw Error("Workspace changed; review the draft in its current workspace.");
      if (!response.ok) throw Error(response.reason);
      return response.data.result;
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Plugin draft request failed.");
      return undefined;
    } finally {
      setBusy(false);
    }
  }
  function accept(value: unknown) {
    const next = pluginDraft(value);
    if (!next) {
      setError("The runtime did not return a verified quarantined draft.");
      return;
    }
    artifactHash.current = next.hash;
    setMaterializedKey("");
    setConfirmed(false);
    setExecutionConsent(false);
    setDraft(next);
    setPath(next.files[0]?.path ?? "");
    setContent(next.files[0]?.content ?? "");
    setReport(null);
  }
  useEffect(() => {
    let disposed = false;
    async function poll() {
      const response = await workspaceRequest<Record<string, unknown>>("plugin-maker");
      if (disposed) return;
      if (!response.ok) {
        setReady(false);
        return;
      }
      const data = response.data;
      if (!Number.isSafeInteger(data.scopeGeneration)) {
        setReady(false);
        return;
      }
      const next = Number(data.scopeGeneration);
      if (generation.current !== null && generation.current !== next) {
        artifactHash.current = "";
        setDraft(null);
        setId("");
        setName("");
        setDescription("");
        setMaterializedKey("");
        setPath("");
        setContent("");
        setDirectory("");
        setConfirmed(false);
        setExecutionConsent(false);
        setReport(null);
        setError("");
      }
      generation.current = next;
      setReady(true);
      setSnapshot(data);
      const active = pluginDraft(data.artifact);
      if (active && active.hash !== artifactHash.current) accept(active);
    }
    void poll();
    const timer = setInterval(() => {
      void poll();
    }, 2000);
    return () => {
      disposed = true;
      clearInterval(timer);
    };
  }, []);
  const dirty =
    draft !== null && content !== (draft.files.find((file) => file.path === path)?.content ?? "");
  async function reviewAction(kind: string) {
    if (!draft) return;
    const result = await action(kind, {
      hash: draft.hash,
      directory,
      scopes: draft.requestedCapabilities,
      confirm: true,
      ...(kind === "test" || kind === "enable" ? { allowExecution: true } : {}),
    });
    if (result !== undefined) {
      if (kind === "materialize") setMaterializedKey(`${draft.hash}:${directory}`);
      setReport(result);
      setConfirmed(false);
      setExecutionConsent(false);
    }
  }
  return (
    <>
      <section className="panel">
        <h2 className="panelTitle">Create a draft</h2>
        <p>
          Use a coding chat to ask the agent to propose or edit this native harness plugin, or start
          from a small local scaffold here.
        </p>
        <p>
          <Link href="/agent">Open coding chat</Link>
        </p>
        <label>
          Plugin ID{" "}
          <input
            maxLength={120}
            value={id}
            disabled={busy}
            onChange={(event) => setId(event.target.value)}
          />
        </label>{" "}
        <label>
          Name{" "}
          <input
            maxLength={120}
            value={name}
            disabled={busy}
            onChange={(event) => setName(event.target.value)}
          />
        </label>
        <p>
          <label>
            Description{" "}
            <textarea
              style={{ width: "100%" }}
              maxLength={2000}
              value={description}
              disabled={busy}
              onChange={(event) => setDescription(event.target.value)}
            />
          </label>
        </p>
        <button
          disabled={busy || !ready || !id.trim() || !name.trim()}
          onClick={() => {
            void action("scaffold", {
              id: id.trim(),
              name: name.trim(),
              description: description.trim(),
              license: "UNLICENSED",
            }).then((result) => {
              if (result !== undefined) accept(result);
            });
          }}
        >
          Create quarantined scaffold
        </button>
      </section>
      {error ? (
        <p className="panel panel--warn" role="alert">
          {error}
        </p>
      ) : null}
      {draft ? (
        <>
          <section className="panel">
            <h2 className="panelTitle">Draft review</h2>
            <p>
              Immutable quarantined proposal. Scaffolding and validation do not execute or install
              code.
            </p>
            <p style={{ overflowWrap: "anywhere" }}>
              Artifact: <code>{draft.hash}</code>
            </p>
            <p>
              Requested capabilities:{" "}
              {draft.requestedCapabilities.length ? draft.requestedCapabilities.join(", ") : "none"}
              .
            </p>
            <label>
              File{" "}
              <select
                style={{ maxWidth: "100%" }}
                value={path}
                disabled={busy}
                onChange={(event) => {
                  setPath(event.target.value);
                  setContent(
                    draft.files.find((file) => file.path === event.target.value)?.content ?? "",
                  );
                }}
              >
                {draft.files.map((file) => (
                  <option key={file.path} value={file.path}>
                    {file.path}
                  </option>
                ))}
              </select>
            </label>
            <p>
              <label>
                Source{" "}
                <textarea
                  style={{ width: "100%", minHeight: 240, fontFamily: "monospace" }}
                  value={content}
                  disabled={busy}
                  onChange={(event) => {
                    setContent(event.target.value);
                    setConfirmed(false);
                    setExecutionConsent(false);
                  }}
                />
              </label>
            </p>
            <p className="muted">
              Editing creates a new artifact and invalidates earlier review. Never put credentials
              or private logs in plugin source.
            </p>
            <div className="btnRow">
              <button
                disabled={busy || !ready || !path}
                onClick={() => {
                  void action("edit", { hash: draft.hash, path, content }).then((result) => {
                    if (result !== undefined) accept(result);
                  });
                }}
              >
                Save new draft revision
              </button>
              <button
                disabled={busy || !ready}
                onClick={() => {
                  void action("validate", { hash: draft.hash }).then((result) => {
                    if (result !== undefined) setReport(result);
                  });
                }}
              >
                Validate draft
              </button>
            </div>
            {report !== null ? (
              <pre
                aria-label="Plugin validation report"
                style={{ whiteSpace: "pre-wrap", overflowWrap: "anywhere" }}
              >
                {JSON.stringify(report, null, 2)}
              </pre>
            ) : null}
          </section>
          <section className="panel">
            <h2 className="panelTitle">Test, review and enable</h2>
            {dirty ? (
              <p role="status">
                Save the edited source as a new draft revision before reviewing or executing it.
              </p>
            ) : null}
            <p>
              Review the exact artifact and requested capabilities above. Materializing writes the
              displayed files to the chosen workspace folder. Executing tests and enabling the
              plugin each require separate explicit approval; validation alone does not execute
              code.
            </p>
            <label>
              Workspace-relative plugin folder{" "}
              <input
                style={{ maxWidth: "100%" }}
                value={directory}
                disabled={busy}
                onChange={(event) => {
                  setDirectory(event.target.value);
                  setConfirmed(false);
                  setExecutionConsent(false);
                }}
              />
            </label>
            <p>
              <label>
                <input
                  type="checkbox"
                  checked={confirmed}
                  disabled={busy}
                  onChange={(event) => setConfirmed(event.target.checked)}
                />{" "}
                I reviewed this exact artifact, folder and requested capabilities and authorize the
                selected action.
              </label>
            </p>
            <p>
              <label>
                <input
                  type="checkbox"
                  checked={executionConsent}
                  disabled={busy}
                  onChange={(event) => setExecutionConsent(event.target.checked)}
                />{" "}
                I authorize code execution for the selected action. Tests run in the required OS
                sandbox. Enabling trusts this exact code to run with daemon authority after restart;
                declared or granted capability lists do not sandbox JavaScript.
              </label>
            </p>
            <div className="btnRow">
              {["materialize", "test", "review", "enable"].map((kind) => (
                <button
                  key={kind}
                  disabled={
                    busy ||
                    !ready ||
                    !directory.trim() ||
                    dirty ||
                    (kind !== "materialize" && materializedKey !== `${draft.hash}:${directory}`) ||
                    (kind === "enable" &&
                      (snapshot.reviewed !== true || !hasExecutedSandboxTests(snapshot.test))) ||
                    !confirmed ||
                    ((kind === "test" || kind === "enable") && !executionConsent)
                  }
                  onClick={() => {
                    void reviewAction(kind);
                  }}
                >
                  {kind === "materialize"
                    ? "Write reviewed draft files"
                    : kind === "test"
                      ? "Run approved tests"
                      : kind === "review"
                        ? "Record exact artifact review"
                        : "Enable reviewed plugin"}
                </button>
              ))}
            </div>
            <p className="muted">
              Write the draft for the selected folder before testing or recording review. Enabling
              stays unavailable until required sandbox tests execute successfully and this exact
              artifact is reviewed.
            </p>
            <p>
              Recorded review: {snapshot.reviewed === true ? "yes" : "no"}. Materialized:{" "}
              {snapshot.materialized === true ? "yes" : "no"}. User-enabled configuration:{" "}
              {snapshot.enabled === true ? "yes" : "no"}.
            </p>
            <p>
              Activation may require a runtime restart.{" "}
              <Link href="/plugins">Check installed plugin permissions and active status</Link>
            </p>
          </section>
        </>
      ) : null}
    </>
  );
}

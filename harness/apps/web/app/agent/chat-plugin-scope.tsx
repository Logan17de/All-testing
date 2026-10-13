"use client";
import { useEffect, useState } from "react";
import { chatPluginInventory, type ChatTool } from "./chat-plugin-view";
export function ChatPluginScope({
  sessionId,
  action,
}: {
  sessionId: string;
  action: (name: string, params: Record<string, unknown>) => Promise<unknown>;
}) {
  const [tools, setTools] = useState<ChatTool[]>([]);
  const [model, setModel] = useState<string[] | null>(null);
  const [execution, setExecution] = useState<string[] | null>(null);
  const [ready, setReady] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [saved, setSaved] = useState(false);
  useEffect(() => {
    let stale = false;
    void action("session/plugins", { sessionId })
      .then((value) => {
        if (stale) return;
        const data = chatPluginInventory(value);
        if (!data) throw Error("Invalid plugin inventory.");
        setTools(data.available);
        setModel(data.restrictions.model);
        setExecution(data.restrictions.tools);
        setReady(true);
      })
      .catch(() => {
        if (!stale) setError("Plugin inventory could not be loaded.");
      });
    return () => {
      stale = true;
    };
  }, [sessionId, action]);
  const groups = [
    { label: "Model node tools", value: model, set: setModel },
    { label: "Tool execution node tools", value: execution, set: setExecution },
  ];
  return (
    <details>
      <summary>Plugin tools for this chat graph</summary>
      <p>
        By default all enabled, granted plugin tools are available. Restrictions apply to the next
        task; the current task keeps its existing scope. Mutation and external interaction consent
        still apply.
      </p>
      {groups.map((group) => (
        <fieldset key={group.label} disabled={!ready || busy}>
          <legend>{group.label}</legend>
          <label>
            <input
              type="checkbox"
              checked={group.value === null}
              onChange={(event) => {
                group.set(event.target.checked ? null : []);
                setSaved(false);
              }}
            />{" "}
            All enabled, granted tools
          </label>
          {group.value !== null
            ? tools.map((tool) => (
                <label key={tool.id} style={{ display: "block" }}>
                  <input
                    type="checkbox"
                    checked={group.value?.includes(tool.id) ?? false}
                    onChange={(event) => {
                      group.set((previous) =>
                        event.target.checked
                          ? [...(previous ?? []), tool.id]
                          : (previous ?? []).filter((id) => id !== tool.id),
                      );
                      setSaved(false);
                    }}
                  />
                  {tool.title} <code>{tool.id}</code> · {tool.pluginId} · {tool.status}
                </label>
              ))
            : null}
          {group.value?.length === 0 ? <p>No tools selected for this node.</p> : null}
        </fieldset>
      ))}
      <button
        disabled={!ready || busy}
        onClick={() => {
          setBusy(true);
          setError("");
          void action("session/plugin-scope", { sessionId, model, tools: execution })
            .then(() => setSaved(true))
            .catch(() => setError("Plugin scope was not saved."))
            .finally(() => setBusy(false));
        }}
      >
        Save next-task plugin scope
      </button>
      {saved ? <p role="status">Plugin scope saved for this chat.</p> : null}
      {error ? <p role="alert">{error}</p> : null}
    </details>
  );
}

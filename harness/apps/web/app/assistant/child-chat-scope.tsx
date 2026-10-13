"use client";
import { useState } from "react";
import type { AssistantGrant, AssistantPermission } from "./assistant-access-view";
export function ChildChatScope({
  grants,
  busy,
  create,
}: {
  grants: AssistantGrant[];
  busy: boolean;
  create: (grants: AssistantGrant[], title?: string) => Promise<void>;
}) {
  const [choices, setChoices] = useState<Record<string, AssistantPermission[]>>({});
  const [title, setTitle] = useState("");
  const subset = grants.flatMap((grant) => {
    const permissions = grant.permissions.filter((permission) =>
      choices[grant.chatId]?.includes(permission),
    );
    return permissions.length ? [{ chatId: grant.chatId, permissions }] : [];
  });
  return (
    <section className="panel">
      <h2 className="panelTitle">Create a bounded child chat</h2>
      <p>
        The assistant can read and control the new child chat. Existing chat connections are
        inherited only when selected. Choices cannot exceed the parent&apos;s granted permissions.
        Existing disconnected chats remain inaccessible.
      </p>
      <p className="muted">
        Child coding runs inherit the user’s tool restrictions. Workspace file changes, process
        execution and Git mutations require explicit turn consent and approval of each exact action.
        Private runtime databases remain excluded. Plugin, MCP, browser, desktop and analysis tools
        remain disabled for these child runs.
      </p>
      <label style={{ display: "block", marginBlock: 12 }}>
        Child title (optional){" "}
        <input
          className="field"
          value={title}
          maxLength={200}
          disabled={busy}
          onChange={(event) => setTitle(event.target.value)}
        />
      </label>
      {!grants.length ? (
        <p className="muted">
          No connections are available to inherit. You can still create a child with no inherited
          chat access.
        </p>
      ) : null}
      {grants.map((grant) => (
        <fieldset key={grant.chatId} disabled={busy}>
          <legend style={{ overflowWrap: "anywhere" }}>{grant.chatId}</legend>
          {grant.permissions.map((permission) => (
            <label key={permission} style={{ display: "block" }}>
              <input
                type="checkbox"
                checked={choices[grant.chatId]?.includes(permission) ?? false}
                onChange={(event) =>
                  setChoices((previous) => ({
                    ...previous,
                    [grant.chatId]: event.target.checked
                      ? [...(previous[grant.chatId] ?? []), permission]
                      : (previous[grant.chatId] ?? []).filter((value) => value !== permission),
                  }))
                }
              />{" "}
              Inherit {permission} access
            </label>
          ))}
        </fieldset>
      ))}
      <button
        className="btn"
        type="button"
        disabled={busy}
        onClick={() => {
          void create(subset, title.trim() || undefined).then(() => {
            setChoices({});
            setTitle("");
          });
        }}
      >
        Create bounded child chat
      </button>
    </section>
  );
}

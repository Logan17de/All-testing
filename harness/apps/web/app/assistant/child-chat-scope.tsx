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
        Choose which current connections the child may inherit. Nothing is inherited by default;
        choices cannot exceed the parent’s granted permissions. Existing disconnected chats remain
        inaccessible.
      </p>
      <label>
        Child title (optional){" "}
        <input
          value={title}
          maxLength={200}
          disabled={busy}
          onChange={(event) => setTitle(event.target.value)}
        />
      </label>
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

"use client";

import { useState } from "react";
import {
  updateChatPreferences,
  useChatPreferences,
  type ChatPreferences,
  type ChatToolOption,
} from "../agent/chat-preferences";
import "./chat-settings.css";

const options: readonly { id: ChatToolOption; title: string; description: string }[] = [
  {
    id: "mutationConsent",
    title: "Workspace changes",
    description: "Allow workspace mutation requests. Each action still needs separate approval.",
  },
  {
    id: "subagentsEnabled",
    title: "Subagents",
    description: "Allow bounded read-only helpers that use additional model inference.",
  },
  {
    id: "searchEnabled",
    title: "Web research",
    description: "Use Codex research with a connected account and configured search model.",
  },
  {
    id: "browserEnabled",
    title: "Browser tools",
    description:
      "Use a separately armed isolated browser session. Browser input requires approval.",
  },
  {
    id: "desktopEnabled",
    title: "Desktop tools",
    description:
      "Use a separately armed local desktop session. Input and screenshot sharing require approval.",
  },
];

export function ChatSettings() {
  const preferences = useChatPreferences();
  const [saveFailed, setSaveFailed] = useState(false);
  function update(change: Partial<ChatPreferences>) {
    setSaveFailed(!updateChatPreferences(change));
  }
  return (
    <div className="settingsChat" aria-label="Chat settings">
      <p className="settingsMuted settingsChatIntro">
        Changes are saved in this browser and apply to your next tasks across chats.
      </p>
      <label className="settingsChatInstructions" htmlFor="settings-chat-instructions">
        <span>Instructions (optional)</span>
        <textarea
          id="settings-chat-instructions"
          rows={4}
          placeholder="Add instructions for your chats"
          value={preferences.instructions}
          onChange={(event) => update({ instructions: event.target.value })}
        />
      </label>
      <section className="settingsChatTools" aria-labelledby="settings-chat-tools-title">
        <h3 id="settings-chat-tools-title">Tools</h3>
        <p className="settingsMuted">
          Enabled by default. These choices request capabilities; each tool keeps its existing
          connection and approval requirements.
        </p>
        {options.map((option) => (
          <label className="settingsChatOption" key={option.id}>
            <span>
              <strong>{option.title}</strong>
              <span className="settingsMuted" id={`settings-chat-${option.id}-help`}>
                {option.description}
              </span>
            </span>
            <input
              type="checkbox"
              aria-label={option.title}
              aria-describedby={`settings-chat-${option.id}-help`}
              checked={preferences[option.id]}
              onChange={(event) => update({ [option.id]: event.target.checked })}
            />
          </label>
        ))}
      </section>
      {saveFailed ? (
        <p className="settingsChatSaveError" role="alert">
          Browser storage is unavailable. These changes apply to this page but may be lost on
          refresh.
        </p>
      ) : null}
    </div>
  );
}

"use client";

import { useEffect, useState, type ReactNode } from "react";
import type { SetupStatus } from "../../lib/runtime-client";
import { workspaceRequest } from "../../lib/workspace-client";
import { updateChatPreferences, useChatPreferences } from "../agent/chat-preferences";
import {
  updateGeneralPreferences,
  useGeneralPreferences,
  type GeneralPreferences,
} from "../agent/general-preferences";
import {
  enableNotificationSound,
  previewNotificationSound,
  requestNotificationPermission,
  useNotificationPermission,
} from "../agent/agent-notifications";
import { DefaultFolderSettings } from "./default-folder-settings";
import "./general-settings.css";

function GeneralRow({
  id,
  title,
  description,
  children,
}: {
  id: string;
  title: string;
  description: string;
  children: ReactNode;
}) {
  return (
    <div className="generalRow">
      <div className="generalRowText">
        <strong id={id}>{title}</strong>
        <p id={id + "-help"}>{description}</p>
      </div>
      <div className="generalRowControl">{children}</div>
    </div>
  );
}
function GeneralSwitch({
  label,
  checked,
  onChange,
}: {
  label: string;
  checked: boolean;
  onChange: (value: boolean) => void;
}) {
  return (
    <button
      type="button"
      role="switch"
      aria-label={label}
      aria-checked={checked}
      className="generalSwitch"
      onClick={() => onChange(!checked)}
    >
      <span className="generalSwitchTrack" aria-hidden="true">
        <span />
      </span>
    </button>
  );
}

export function GeneralSettings({ onOpenChatSettings }: { onOpenChatSettings?: () => void }) {
  const [setup, setSetup] = useState<SetupStatus | null>(null);
  const [error, setError] = useState("");
  const [version, setVersion] = useState(0);
  const [saveFailed, setSaveFailed] = useState(false);
  const [notificationBusy, setNotificationBusy] = useState(false);
  const [soundBusy, setSoundBusy] = useState(false);
  const [feedback, setFeedback] = useState("");
  const preferences = useGeneralPreferences();
  const chatPreferences = useChatPreferences();
  const permission = useNotificationPermission();
  useEffect(() => {
    let stale = false;
    void workspaceRequest<{ setup: SetupStatus }>("setup").then((result) => {
      if (stale) return;
      if (result.ok) setSetup(result.data.setup);
      else setError(result.reason);
    });
    return () => {
      stale = true;
    };
  }, [version]);
  function update(change: Partial<GeneralPreferences>) {
    setSaveFailed(!updateGeneralPreferences(change));
  }
  async function enableNotifications() {
    setNotificationBusy(true);
    setFeedback("");
    try {
      const result = await requestNotificationPermission();
      setFeedback(
        result === "granted"
          ? "Browser notifications enabled."
          : result === "denied"
            ? "Notifications are blocked. Allow them in this browser's site settings."
            : result === "unsupported"
              ? "Notifications are unavailable in this browser."
              : "Notification permission was not granted.",
      );
    } finally {
      setNotificationBusy(false);
    }
  }
  async function chooseSound(value: string) {
    setFeedback("");
    if (value === "off") {
      update({ notificationSound: "off" });
      return;
    }
    setSoundBusy(true);
    try {
      if (await enableNotificationSound()) update({ notificationSound: "chime" });
      else setFeedback("Sound is unavailable. Use Test sound after interacting with this page.");
    } finally {
      setSoundBusy(false);
    }
  }
  return (
    <div className="settingsGeneral">
      <section className="generalSection" aria-labelledby="general-permissions-heading">
        <h3 id="general-permissions-heading">Permissions</h3>
        <div className="generalCard">
          <GeneralRow
            id="general-default-permissions"
            title="Default permissions"
            description="Allow workspace change requests. Protected actions still require approval."
          >
            <GeneralSwitch
              label="Default permissions"
              checked={chatPreferences.mutationConsent}
              onChange={(mutationConsent) =>
                setSaveFailed(!updateChatPreferences({ mutationConsent }))
              }
            />
          </GeneralRow>
          <GeneralRow
            id="general-tool-permissions"
            title="Tool permissions"
            description="Choose the tools available to your next chat tasks."
          >
            {onOpenChatSettings ? (
              <button type="button" className="generalButton" onClick={onOpenChatSettings}>
                Manage
              </button>
            ) : (
              <a className="generalButton" href="/settings?section=chat">
                Manage
              </a>
            )}
          </GeneralRow>
        </div>
      </section>
      <section className="generalSection" aria-labelledby="general-behavior-heading">
        <h3 id="general-behavior-heading">General</h3>
        <div className="generalCard">
          {error ? (
            <div className="generalFolderError" role="alert">
              <p>{error}</p>
              <button
                className="generalButton"
                type="button"
                onClick={() => {
                  setError("");
                  setVersion((value) => value + 1);
                }}
              >
                Retry folder settings
              </button>
            </div>
          ) : setup ? (
            <DefaultFolderSettings initial={setup} presentation="row" />
          ) : (
            <div className="generalRow">
              <p role="status" className="settingsMuted">
                Loading folder settings.
              </p>
            </div>
          )}
          <GeneralRow
            id="general-send-shortcut"
            title="Send shortcut"
            description="Choose when Enter sends a prompt or inserts a new line."
          >
            <select
              aria-label="Send shortcut"
              value={preferences.sendShortcut}
              onChange={(event) =>
                update({ sendShortcut: event.target.value === "mod-enter" ? "mod-enter" : "enter" })
              }
            >
              <option value="enter">Enter</option>
              <option value="mod-enter">Ctrl / ⌘ + Enter</option>
            </select>
          </GeneralRow>
          <GeneralRow
            id="general-confirm-close"
            title="Confirm before leaving"
            description="Warn before closing or reloading a tab with an unsent draft or running task."
          >
            <GeneralSwitch
              label="Confirm before leaving"
              checked={preferences.confirmBeforeClose}
              onChange={(confirmBeforeClose) => update({ confirmBeforeClose })}
            />
          </GeneralRow>
          <GeneralRow
            id="general-full-view"
            title="Full view by default"
            description="Start chats with the side panel closed for a wider conversation."
          >
            <GeneralSwitch
              label="Full view by default"
              checked={!preferences.openSidePanelByDefault}
              onChange={(fullView) => update({ openSidePanelByDefault: !fullView })}
            />
          </GeneralRow>
        </div>
      </section>
      <section className="generalSection" aria-labelledby="general-notifications-heading">
        <h3 id="general-notifications-heading">Notifications</h3>
        <div className="generalCard">
          <GeneralRow
            id="general-browser-notifications"
            title="Browser notifications"
            description={
              permission === "granted"
                ? "Notifications are allowed while this harness tab is open."
                : permission === "denied"
                  ? "Notifications are blocked. Allow them in your browser's site settings."
                  : permission === "unsupported"
                    ? "Notifications are unavailable in this browser."
                    : "Allow this browser to show task and approval alerts."
            }
          >
            {permission === "default" ? (
              <button
                type="button"
                className="generalButton"
                disabled={notificationBusy}
                onClick={() => {
                  void enableNotifications();
                }}
              >
                {notificationBusy ? "Enabling…" : "Enable"}
              </button>
            ) : (
              <span className="generalStatus">
                {permission === "granted"
                  ? "Allowed"
                  : permission === "denied"
                    ? "Blocked"
                    : "Unavailable"}
              </span>
            )}
          </GeneralRow>
          <GeneralRow
            id="general-completion-notifications"
            title="Task completion notifications"
            description="Choose when the harness alerts you that a task has finished."
          >
            <select
              aria-label="Task completion notifications"
              value={preferences.turnCompletionNotifications}
              onChange={(event) =>
                update({
                  turnCompletionNotifications:
                    event.target.value === "always"
                      ? "always"
                      : event.target.value === "never"
                        ? "never"
                        : "unfocused",
                })
              }
            >
              <option value="unfocused">Only when unfocused</option>
              <option value="always">Always</option>
              <option value="never">Never</option>
            </select>
          </GeneralRow>
          <GeneralRow
            id="general-permission-notifications"
            title="Permission request notifications"
            description="Show an alert when a task needs your approval."
          >
            <GeneralSwitch
              label="Permission request notifications"
              checked={preferences.permissionNotifications}
              onChange={(permissionNotifications) => update({ permissionNotifications })}
            />
          </GeneralRow>
          <GeneralRow
            id="general-notification-sound"
            title="Notification sound"
            description="Play a short chime with task and permission notifications."
          >
            <div className="generalSoundControls">
              <select
                aria-label="Notification sound"
                disabled={soundBusy}
                value={preferences.notificationSound}
                onChange={(event) => {
                  void chooseSound(event.target.value);
                }}
              >
                <option value="off">Off</option>
                <option value="chime">Chime</option>
              </select>
              <button
                type="button"
                className="generalButton"
                disabled={soundBusy}
                onClick={() => {
                  setSoundBusy(true);
                  void previewNotificationSound().then((played) => {
                    setFeedback(
                      played ? "Test chime played." : "Sound is unavailable in this browser.",
                    );
                    setSoundBusy(false);
                  });
                }}
              >
                Test sound
              </button>
            </div>
          </GeneralRow>
        </div>
        <p className="generalFootnote">
          Alerts are available while the coding workspace is open in this tab. Browser permission is
          required. Sound starts after your first interaction with the page.
        </p>
        {feedback ? (
          <p className="generalFeedback" role="status">
            {feedback}
          </p>
        ) : null}
      </section>
      {saveFailed ? (
        <p className="generalError" role="alert">
          Browser storage is unavailable. Changes apply to this page but may be lost on refresh.
        </p>
      ) : null}
    </div>
  );
}

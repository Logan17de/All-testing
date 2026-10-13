"use client";

import { useEffect, useRef, useSyncExternalStore } from "react";
import type { AgentRun } from "./agent-view";
import type { GeneralPreferences } from "./general-preferences";

export type BrowserNotificationPermission = NotificationPermission | "unsupported";
export type NotificationPreferences = Pick<
  GeneralPreferences,
  "turnCompletionNotifications" | "permissionNotifications" | "notificationSound"
>;
export type AgentNotificationSnapshot = {
  scopeKey: string;
  ready: boolean;
  runs: Readonly<Record<string, AgentRun>>;
  approvals: readonly { id: string; runId: string }[];
};
type AgentNotification = { kind: "completed" | "failed" | "permission"; tag: string };
const permissionChanged = "zet:notification-permission-changed";
const terminalStatuses = new Set(["completed", "failed", "cancelled", "interrupted"]);

const object = (value: unknown): Record<string, unknown> =>
  value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};

export function notificationApprovals(
  toolApprovals: unknown,
  pendingApprovals: unknown,
  runs: Readonly<Record<string, AgentRun>>,
  now = Date.now(),
): AgentNotificationSnapshot["approvals"] {
  const activeRuns = new Map(
    Object.entries(runs)
      .filter(([, run]) => !terminalStatuses.has(run.status))
      .map(([sessionId, run]) => [run.id, sessionId]),
  );
  const approvals = new Map<string, { id: string; runId: string }>();
  for (const raw of Array.isArray(toolApprovals) ? toolApprovals : []) {
    const approval = object(raw);
    if (
      typeof approval.id !== "string" ||
      !approval.id ||
      typeof approval.runId !== "string" ||
      activeRuns.get(approval.runId) !== approval.sessionId ||
      typeof approval.sessionId !== "string" ||
      typeof approval.expiresAtMs !== "number" ||
      !Number.isFinite(approval.expiresAtMs) ||
      approval.expiresAtMs <= now
    )
      continue;
    const id = `tool:${approval.id}`;
    approvals.set(id, { id, runId: approval.runId });
  }
  for (const raw of Array.isArray(pendingApprovals) ? pendingApprovals : []) {
    const approval = object(raw);
    if (
      typeof approval.approvalId !== "string" ||
      !approval.approvalId ||
      typeof approval.runId !== "string" ||
      !activeRuns.has(approval.runId) ||
      approval.status !== "pending" ||
      (approval.expiresAtMs !== null &&
        (typeof approval.expiresAtMs !== "number" ||
          !Number.isFinite(approval.expiresAtMs) ||
          approval.expiresAtMs <= now))
    )
      continue;
    const id = `durable:${approval.approvalId}`;
    approvals.set(id, { id, runId: approval.runId });
  }
  return [...approvals.values()];
}

export function readNotificationPermission(): BrowserNotificationPermission {
  if (typeof window === "undefined" || typeof window.Notification !== "function")
    return "unsupported";
  return window.Notification.permission;
}

function subscribeNotificationPermission(onChange: () => void): () => void {
  window.addEventListener(permissionChanged, onChange);
  window.addEventListener("focus", onChange);
  document.addEventListener("visibilitychange", onChange);
  return () => {
    window.removeEventListener(permissionChanged, onChange);
    window.removeEventListener("focus", onChange);
    document.removeEventListener("visibilitychange", onChange);
  };
}

export function useNotificationPermission(): BrowserNotificationPermission {
  return useSyncExternalStore(
    subscribeNotificationPermission,
    readNotificationPermission,
    () => "unsupported",
  );
}

// Call directly from the Enable button. Polling and preference effects never ask for access.
export async function requestNotificationPermission(): Promise<BrowserNotificationPermission> {
  const permission = readNotificationPermission();
  if (permission !== "default" || window.navigator.userActivation?.isActive === false)
    return permission;
  try {
    await window.Notification.requestPermission();
  } catch {
    // Browsers can refuse the request without changing their permission state.
  }
  window.dispatchEvent(new Event(permissionChanged));
  return readNotificationPermission();
}

let soundContext: AudioContext | null = null;

// Audio is armed by a settings gesture and lasts only for this page's lifetime.
export async function enableNotificationSound(): Promise<boolean> {
  if (typeof window === "undefined" || typeof window.AudioContext !== "function") return false;
  if (window.navigator.userActivation?.isActive === false) return false;
  try {
    soundContext ??= new window.AudioContext();
    if (soundContext.state === "suspended") await soundContext.resume();
    return soundContext.state === "running";
  } catch {
    return false;
  }
}

function playChime(): boolean {
  if (!soundContext || soundContext.state !== "running") return false;
  try {
    const oscillator = soundContext.createOscillator();
    const gain = soundContext.createGain();
    const start = soundContext.currentTime;
    oscillator.frequency.setValueAtTime(660, start);
    oscillator.frequency.setValueAtTime(880, start + 0.1);
    gain.gain.setValueAtTime(0, start);
    gain.gain.linearRampToValueAtTime(0.08, start + 0.015);
    gain.gain.exponentialRampToValueAtTime(0.001, start + 0.24);
    oscillator.connect(gain);
    gain.connect(soundContext.destination);
    oscillator.onended = () => {
      oscillator.disconnect();
      gain.disconnect();
    };
    oscillator.start(start);
    oscillator.stop(start + 0.25);
    return true;
  } catch {
    return false;
  }
}

export async function previewNotificationSound(): Promise<boolean> {
  return (await enableNotificationSound()) && playChime();
}

export function armNotificationSoundOnInteraction(): () => void {
  let disposed = false;
  let arming = false;
  const removeListeners = () => {
    window.removeEventListener("pointerdown", arm);
    window.removeEventListener("keydown", arm);
  };
  const arm = (event: Event) => {
    if (disposed || arming || !event.isTrusted) return;
    arming = true;
    void enableNotificationSound().then((enabled) => {
      arming = false;
      if (enabled) removeListeners();
    });
  };
  window.addEventListener("pointerdown", arm);
  window.addEventListener("keydown", arm);
  return () => {
    disposed = true;
    removeListeners();
  };
}

export function createAgentNotificationTracker() {
  const observedActiveRuns = new Set<string>();
  const settledRuns = new Set<string>();
  const seenApprovals = new Set<string>();
  return {
    observe(snapshot: AgentNotificationSnapshot): AgentNotification[] {
      if (!snapshot.ready) return [];
      const notifications: AgentNotification[] = [];
      const { runs, scopeKey } = snapshot;
      for (const [sessionId, run] of Object.entries(runs)) {
        const key = JSON.stringify([scopeKey, sessionId, run.id]);
        if (terminalStatuses.has(run.status)) {
          if (
            observedActiveRuns.has(key) &&
            !settledRuns.has(key) &&
            (run.status === "completed" || run.status === "failed")
          )
            notifications.push({ kind: run.status, tag: `zet:run:${key}` });
          // Historical terminal runs establish a baseline; they never alert on page load.
          settledRuns.add(key);
          observedActiveRuns.delete(key);
        } else if (!settledRuns.has(key)) observedActiveRuns.add(key);
        if (!terminalStatuses.has(run.status)) {
          let firstNewApproval: string | undefined;
          for (const approval of snapshot.approvals) {
            if (approval.runId !== run.id) continue;
            const key = JSON.stringify([scopeKey, run.id, approval.id]);
            if (seenApprovals.has(key)) continue;
            seenApprovals.add(key);
            firstNewApproval ??= key;
          }
          if (firstNewApproval)
            notifications.push({ kind: "permission", tag: `zet:approval:${firstNewApproval}` });
        }
      }
      return notifications;
    },
  };
}

export type AgentNotificationTracker = ReturnType<typeof createAgentNotificationTracker>;

function windowIsUnfocused(): boolean {
  return document.visibilityState === "hidden" || !document.hasFocus();
}

export function deliverAgentNotifications(
  tracker: AgentNotificationTracker,
  snapshot: AgentNotificationSnapshot,
  preferences: NotificationPreferences,
): void {
  // Consume updates even when alerts are disabled, so enabling them cannot replay old events.
  const updates = tracker.observe(snapshot);
  if (readNotificationPermission() !== "granted") return;
  for (const update of updates) {
    if (update.kind === "permission") {
      if (!preferences.permissionNotifications) continue;
    } else if (
      preferences.turnCompletionNotifications === "never" ||
      (preferences.turnCompletionNotifications === "unfocused" && !windowIsUnfocused())
    )
      continue;
    const title =
      update.kind === "permission"
        ? "Permission needed"
        : update.kind === "failed"
          ? "Task failed"
          : "Task finished";
    const body =
      update.kind === "permission"
        ? "A task needs your approval. Open the workspace to review it."
        : update.kind === "failed"
          ? "A task stopped with an error. Open the workspace to review it."
          : "Your task has finished. Open the workspace to review it.";
    try {
      const notification = new window.Notification(title, {
        body,
        tag: update.tag,
        silent: true,
      });
      notification.onclick = () => {
        window.focus();
        notification.close();
      };
      if (preferences.notificationSound === "chime") playChime();
    } catch {
      // A supported API may still be blocked by browser or operating-system policy.
    }
  }
}

export function useAgentNotifications(
  snapshot: AgentNotificationSnapshot,
  preferences: NotificationPreferences,
): void {
  const tracker = useRef<AgentNotificationTracker | null>(null);
  useEffect(() => {
    tracker.current ??= createAgentNotificationTracker();
    deliverAgentNotifications(tracker.current, snapshot, preferences);
  }, [snapshot, preferences]);
  useEffect(() => {
    if (preferences.notificationSound !== "chime") return;
    return armNotificationSoundOnInteraction();
  }, [preferences.notificationSound]);
}

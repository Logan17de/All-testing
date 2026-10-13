import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_GENERAL_PREFERENCES } from "./general-preferences";
import {
  createAgentNotificationTracker,
  deliverAgentNotifications,
  notificationApprovals,
  readNotificationPermission,
  requestNotificationPermission,
  type AgentNotificationSnapshot,
  type NotificationPreferences,
} from "./agent-notifications";

describe("agent browser notifications", () => {
  beforeEach(() => vi.resetModules());
  afterEach(() => vi.unstubAllGlobals());

  function browser(permission: NotificationPermission = "granted") {
    const notifications: {
      title: string;
      options: NotificationOptions | undefined;
      onclick: (() => void) | null;
      close: ReturnType<typeof vi.fn>;
    }[] = [];
    class FakeNotification {
      static permission = permission;
      static requestPermission = vi.fn(() => {
        FakeNotification.permission = "granted";
        return Promise.resolve("granted" as const);
      });
      onclick: (() => void) | null = null;
      close = vi.fn();
      readonly title: string;
      readonly options: NotificationOptions | undefined;
      constructor(title: string, options?: NotificationOptions) {
        this.title = title;
        this.options = options;
        notifications.push(this);
      }
    }
    const target = new EventTarget();
    const focus = vi.fn();
    const userActivation = { isActive: true };
    const document = Object.assign(new EventTarget(), {
      visibilityState: "visible",
      hasFocus: vi.fn(() => true),
    });
    vi.stubGlobal(
      "window",
      Object.assign(target, {
        Notification: FakeNotification,
        focus,
        navigator: { userActivation },
      }),
    );
    vi.stubGlobal("document", document);
    return { notifications, FakeNotification, target, focus, document, userActivation };
  }

  function snapshot(
    status: string,
    approvalIds: readonly string[] = [],
    change: Partial<AgentNotificationSnapshot> = {},
  ): AgentNotificationSnapshot {
    return {
      ready: true,
      scopeKey: "workspace:session",
      runs: { session: { id: "run-1", status } },
      approvals: approvalIds.map((id) => ({ id, runId: "run-1" })),
      ...change,
    };
  }

  const always: NotificationPreferences = {
    ...DEFAULT_GENERAL_PREFERENCES,
    turnCompletionNotifications: "always",
  };

  it("does not alert for historical terminal runs or incomplete snapshots", () => {
    const { notifications } = browser();
    const tracker = createAgentNotificationTracker();
    deliverAgentNotifications(tracker, snapshot("running", [], { ready: false }), always);
    deliverAgentNotifications(tracker, snapshot("completed"), always);
    deliverAgentNotifications(tracker, snapshot("failed"), always);
    expect(notifications).toEqual([]);
  });

  it("alerts once for observed completion or failure, including duplicate polls and scope returns", () => {
    const { notifications } = browser();
    const tracker = createAgentNotificationTracker();
    deliverAgentNotifications(tracker, snapshot("running"), always);
    deliverAgentNotifications(tracker, snapshot("completed"), always);
    deliverAgentNotifications(tracker, snapshot("completed"), always);
    const otherScope = { scopeKey: "workspace:other-session" };
    deliverAgentNotifications(tracker, snapshot("waiting", [], otherScope), always);
    deliverAgentNotifications(tracker, snapshot("failed", [], otherScope), always);
    deliverAgentNotifications(tracker, snapshot("completed"), always);
    expect(notifications.map((item) => item.title)).toEqual(["Task finished", "Task failed"]);
  });

  it("observes other chats so switching the selected chat cannot lose a completion", () => {
    const { notifications } = browser();
    const tracker = createAgentNotificationTracker();
    const first = snapshot("running", [], {
      runs: {
        selectedChat: { id: "run-1", status: "running" },
        otherChat: { id: "run-2", status: "waiting" },
      },
    });
    deliverAgentNotifications(tracker, first, always);
    deliverAgentNotifications(
      tracker,
      {
        ...first,
        runs: {
          selectedChat: { id: "run-1", status: "running" },
          otherChat: { id: "run-2", status: "completed" },
        },
      },
      always,
    );
    expect(notifications.map((item) => item.title)).toEqual(["Task finished"]);
  });

  it("filters scoped pending approvals, expired requests, terminal runs, and malformed values", () => {
    const runs = {
      session: { id: "run-1", status: "waiting" },
      otherSession: { id: "run-2", status: "running" },
      finished: { id: "run-3", status: "completed" },
    };
    const tool = {
      id: "tool-1",
      runId: "run-1",
      sessionId: "session",
      expiresAtMs: 101,
    };
    const durable = {
      approvalId: "approval-1",
      runId: "run-2",
      status: "pending",
      expiresAtMs: null,
    };
    expect(
      notificationApprovals(
        [
          tool,
          tool,
          { ...tool, id: "expired", expiresAtMs: 100 },
          { ...tool, id: "wrong-session", sessionId: "otherSession" },
          { ...tool, id: "unknown-run", runId: "missing" },
          { ...tool, id: "finished", sessionId: "finished", runId: "run-3" },
          { ...tool, id: "bad-expiry", expiresAtMs: Number.NaN },
          { ...tool, id: "" },
          null,
        ],
        [
          durable,
          durable,
          { ...durable, approvalId: "with-expiry", expiresAtMs: 101 },
          { ...durable, approvalId: "expired", expiresAtMs: 100 },
          { ...durable, approvalId: "resolved", status: "approved" },
          { ...durable, approvalId: "unknown-run", runId: "missing" },
          { ...durable, approvalId: "finished", runId: "run-3" },
          { ...durable, approvalId: "malformed", expiresAtMs: "101" },
          { ...durable, approvalId: "" },
          [],
        ],
        runs,
        100,
      ),
    ).toEqual([
      { id: "tool:tool-1", runId: "run-1" },
      { id: "durable:approval-1", runId: "run-2" },
      { id: "durable:with-expiry", runId: "run-2" },
    ]);
    expect(notificationApprovals({}, null, runs, 100)).toEqual([]);
  });

  it("does not alert for cancellation, interruption, or replacement by an unseen terminal run", () => {
    const { notifications } = browser();
    for (const status of ["cancelled", "interrupted"]) {
      const tracker = createAgentNotificationTracker();
      deliverAgentNotifications(tracker, snapshot("running"), always);
      deliverAgentNotifications(tracker, snapshot(status), always);
    }
    const tracker = createAgentNotificationTracker();
    deliverAgentNotifications(tracker, snapshot("running"), always);
    deliverAgentNotifications(
      tracker,
      snapshot("completed", [], { runs: { session: { id: "new-run", status: "completed" } } }),
      always,
    );
    expect(notifications).toEqual([]);
  });

  it("respects focused, blurred, hidden, always, and never completion choices", () => {
    const { notifications, document } = browser();
    const complete = (preferences = DEFAULT_GENERAL_PREFERENCES) => {
      const tracker = createAgentNotificationTracker();
      deliverAgentNotifications(tracker, snapshot("running"), preferences);
      deliverAgentNotifications(tracker, snapshot("completed"), preferences);
    };
    complete();
    expect(notifications).toHaveLength(0);
    document.hasFocus.mockReturnValue(false);
    complete();
    document.hasFocus.mockReturnValue(true);
    document.visibilityState = "hidden";
    complete();
    document.visibilityState = "visible";
    complete({ ...DEFAULT_GENERAL_PREFERENCES, turnCompletionNotifications: "always" });
    document.visibilityState = "hidden";
    complete({ ...DEFAULT_GENERAL_PREFERENCES, turnCompletionNotifications: "never" });
    expect(notifications).toHaveLength(3);
  });

  it("deduplicates approval polls, coalesces a batch, and ignores approval IDs on terminal runs", () => {
    const { notifications } = browser();
    const tracker = createAgentNotificationTracker();
    deliverAgentNotifications(tracker, snapshot("waiting", ["approve-1", "approve-2"]), always);
    deliverAgentNotifications(tracker, snapshot("waiting", ["approve-2", "approve-1"]), always);
    deliverAgentNotifications(tracker, snapshot("running"), always);
    deliverAgentNotifications(tracker, snapshot("waiting", ["approve-1", "approve-3"]), always);
    deliverAgentNotifications(tracker, snapshot("cancelled", ["stale-approval"]), always);
    expect(notifications.map((item) => item.title)).toEqual([
      "Permission needed",
      "Permission needed",
    ]);
  });

  it("consumes disabled alerts so preference changes do not replay them", () => {
    const { notifications } = browser();
    const tracker = createAgentNotificationTracker();
    const disabled = {
      ...always,
      turnCompletionNotifications: "never" as const,
      permissionNotifications: false,
    };
    deliverAgentNotifications(tracker, snapshot("waiting", ["approve-1"]), disabled);
    deliverAgentNotifications(tracker, snapshot("waiting", ["approve-1"]), always);
    deliverAgentNotifications(tracker, snapshot("completed"), disabled);
    deliverAgentNotifications(tracker, snapshot("completed"), always);
    expect(notifications).toEqual([]);
  });

  it("requires granted permission and never asks for permission from task updates", () => {
    for (const permission of ["default", "denied"] as const) {
      const { notifications, FakeNotification } = browser(permission);
      const tracker = createAgentNotificationTracker();
      deliverAgentNotifications(tracker, snapshot("waiting", ["approve-1"]), always);
      deliverAgentNotifications(tracker, snapshot("completed"), always);
      FakeNotification.permission = "granted";
      deliverAgentNotifications(tracker, snapshot("completed"), always);
      expect(notifications).toEqual([]);
      expect(FakeNotification.requestPermission).not.toHaveBeenCalled();
    }
    vi.stubGlobal("window", {});
    expect(readNotificationPermission()).toBe("unsupported");
    const tracker = createAgentNotificationTracker();
    expect(() => deliverAgentNotifications(tracker, snapshot("running"), always)).not.toThrow();
    expect(() => deliverAgentNotifications(tracker, snapshot("completed"), always)).not.toThrow();
  });

  it("uses private generic copy and focuses the window when an alert is clicked", () => {
    const { notifications, focus } = browser();
    const tracker = createAgentNotificationTracker();
    deliverAgentNotifications(tracker, snapshot("waiting", ["approve-1"]), always);
    const notification = notifications[0]!;
    expect(notification.options?.body).toBe(
      "A task needs your approval. Open the workspace to review it.",
    );
    expect(notification.options?.silent).toBe(true);
    expect(notification.options?.body).not.toContain("run-1");
    notification.onclick!();
    expect(focus).toHaveBeenCalledOnce();
    expect(notification.close).toHaveBeenCalledOnce();
  });

  it("tolerates notification delivery rejected by browser policy without retrying polls", () => {
    const { target, FakeNotification } = browser();
    const construct = vi.fn(function () {
      throw new Error("Browser policy blocks notifications");
    });
    Object.assign(construct, { permission: FakeNotification.permission });
    Object.assign(target, { Notification: construct });
    const tracker = createAgentNotificationTracker();
    deliverAgentNotifications(tracker, snapshot("running"), always);
    expect(() => deliverAgentNotifications(tracker, snapshot("completed"), always)).not.toThrow();
    deliverAgentNotifications(tracker, snapshot("completed"), always);
    expect(construct).toHaveBeenCalledOnce();
  });

  it("requests permission only when explicitly called with an active user gesture", async () => {
    const { FakeNotification, target, userActivation } = browser("default");
    const changed = vi.fn();
    target.addEventListener("zet:notification-permission-changed", changed);
    userActivation.isActive = false;
    expect(await requestNotificationPermission()).toBe("default");
    expect(FakeNotification.requestPermission).not.toHaveBeenCalled();
    userActivation.isActive = true;
    expect(await requestNotificationPermission()).toBe("granted");
    expect(FakeNotification.requestPermission).toHaveBeenCalledOnce();
    expect(changed).toHaveBeenCalledOnce();
    await requestNotificationPermission();
    expect(FakeNotification.requestPermission).toHaveBeenCalledOnce();
  });

  it("does not request denied or unsupported permission and tolerates request errors", async () => {
    const { FakeNotification } = browser("denied");
    expect(await requestNotificationPermission()).toBe("denied");
    expect(FakeNotification.requestPermission).not.toHaveBeenCalled();
    FakeNotification.permission = "default";
    FakeNotification.requestPermission.mockRejectedValueOnce(new Error("Permission unavailable"));
    expect(await requestNotificationPermission()).toBe("default");
    vi.stubGlobal("window", {});
    expect(await requestNotificationPermission()).toBe("unsupported");
    vi.stubGlobal("window", undefined);
    expect(readNotificationPermission()).toBe("unsupported");
  });

  it("silently arms a persisted chime on the first trusted active interaction", async () => {
    const { target, FakeNotification, userActivation } = browser();
    const context = {
      state: "running",
      createOscillator: vi.fn(),
      resume: vi.fn(),
    };
    const AudioContext = vi.fn(function () {
      return context;
    });
    Object.assign(target, { AudioContext });
    const remove = vi.spyOn(target, "removeEventListener");
    const notificationsApi = await import("./agent-notifications");
    const cleanup = notificationsApi.armNotificationSoundOnInteraction();
    const interact = (type: string) => {
      const event = new Event(type);
      Object.defineProperty(event, "isTrusted", { value: true });
      target.dispatchEvent(event);
    };
    expect(AudioContext).not.toHaveBeenCalled();
    target.dispatchEvent(new Event("pointerdown"));
    expect(AudioContext).not.toHaveBeenCalled();
    userActivation.isActive = false;
    interact("pointerdown");
    await Promise.resolve();
    expect(AudioContext).not.toHaveBeenCalled();
    userActivation.isActive = true;
    interact("keydown");
    await Promise.resolve();
    expect(AudioContext).toHaveBeenCalledOnce();
    expect(context.createOscillator).not.toHaveBeenCalled();
    expect(FakeNotification.requestPermission).not.toHaveBeenCalled();
    expect(remove).toHaveBeenCalledWith("pointerdown", expect.any(Function));
    expect(remove).toHaveBeenCalledWith("keydown", expect.any(Function));
    cleanup();
  });

  it("removes sound activation listeners when the workspace closes or the choice is disabled", async () => {
    const { target } = browser();
    const AudioContext = vi.fn();
    Object.assign(target, { AudioContext });
    const notificationsApi = await import("./agent-notifications");
    const cleanup = notificationsApi.armNotificationSoundOnInteraction();
    cleanup();
    for (const type of ["pointerdown", "keydown"]) {
      const event = new Event(type);
      Object.defineProperty(event, "isTrusted", { value: true });
      target.dispatchEvent(event);
    }
    await Promise.resolve();
    expect(AudioContext).not.toHaveBeenCalled();
  });

  it("plays an optional chime only after settings explicitly arm browser audio", async () => {
    const { target, userActivation } = browser();
    const oscillator = {
      frequency: { setValueAtTime: vi.fn() },
      connect: vi.fn(),
      disconnect: vi.fn(),
      start: vi.fn(),
      stop: vi.fn(),
      onended: null as (() => void) | null,
    };
    const gain = {
      gain: {
        setValueAtTime: vi.fn(),
        linearRampToValueAtTime: vi.fn(),
        exponentialRampToValueAtTime: vi.fn(),
      },
      connect: vi.fn(),
      disconnect: vi.fn(),
    };
    const context = {
      state: "suspended",
      currentTime: 5,
      destination: {},
      resume: vi.fn(() => {
        context.state = "running";
        return Promise.resolve();
      }),
      createOscillator: vi.fn(() => oscillator),
      createGain: vi.fn(() => gain),
    };
    const AudioContext = vi.fn(function () {
      return context;
    });
    Object.assign(target, { AudioContext });
    const notificationsApi = await import("./agent-notifications");
    const preferences = { ...always, notificationSound: "chime" as const };
    const tracker = notificationsApi.createAgentNotificationTracker();
    notificationsApi.deliverAgentNotifications(
      tracker,
      snapshot("waiting", ["approve-1"]),
      preferences,
    );
    expect(AudioContext).not.toHaveBeenCalled();
    userActivation.isActive = false;
    expect(await notificationsApi.enableNotificationSound()).toBe(false);
    expect(AudioContext).not.toHaveBeenCalled();
    userActivation.isActive = true;
    expect(await notificationsApi.previewNotificationSound()).toBe(true);
    expect(AudioContext).toHaveBeenCalledOnce();
    expect(context.resume).toHaveBeenCalledOnce();
    expect(oscillator.start).toHaveBeenCalledOnce();
    notificationsApi.deliverAgentNotifications(
      tracker,
      snapshot("waiting", ["approve-2"]),
      preferences,
    );
    expect(oscillator.start).toHaveBeenCalledTimes(2);
    notificationsApi.deliverAgentNotifications(tracker, snapshot("waiting", ["approve-3"]), {
      ...preferences,
      notificationSound: "off",
    });
    expect(oscillator.start).toHaveBeenCalledTimes(2);
    oscillator.onended!();
    expect(oscillator.disconnect).toHaveBeenCalledOnce();
    expect(gain.disconnect).toHaveBeenCalledOnce();
  });
});

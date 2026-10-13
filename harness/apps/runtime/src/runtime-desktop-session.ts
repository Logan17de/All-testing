import { randomUUID } from "node:crypto";

export interface DesktopMonitor {
  id: string;
  x: number;
  y: number;
  width: number;
  height: number;
  scale: number;
}
export type DesktopRectangle = {
  x: number;
  y: number;
  width: number;
  height: number;
};
export interface DesktopWindow {
  id: string;
  title: string;
  processId?: number;
  processStartedAt?: string;
  windowClass?: string;
  focused?: boolean;
  bounds?: DesktopRectangle;
}
export type DesktopAction =
  | { kind: "move" | "click"; x: number; y: number }
  | { kind: "observed-click"; artifactId: string; x: number; y: number }
  | {
      kind: "key";
      key:
        | "Tab"
        | "Escape"
        | "Enter"
        | "Backspace"
        | "ArrowUp"
        | "ArrowDown"
        | "ArrowLeft"
        | "ArrowRight";
    }
  | { kind: "text"; text: string }
  | { kind: "focus"; windowId: string };
export interface DesktopCapture {
  localPath: string;
  width: number;
  height: number;
  scope?: DesktopCaptureScope;
}
export interface DesktopDriver {
  inventory(signal: AbortSignal): Promise<{ monitors: DesktopMonitor[]; windows: DesktopWindow[] }>;
  capture(monitor: DesktopMonitor, signal: AbortSignal): Promise<DesktopCapture>;
  captureWindow?(
    window: DesktopWindow,
    monitor: DesktopMonitor,
    signal: AbortSignal,
  ): Promise<DesktopCapture>;
  act(action: DesktopAction, signal: AbortSignal): Promise<void>;
  removeCapture(capture: DesktopCapture): Promise<void>;
}
export interface DesktopTransmissionDestination {
  readonly runId: string;
  readonly sessionId: string;
  readonly modelId: string;
  readonly accountId: string | null;
  readonly maxUses: number;
  readonly expiresAtMs: number;
}
export type DesktopCaptureScope = {
  readonly monitorId: string;
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
  readonly windowId?: string;
  readonly windowBounds?: DesktopRectangle;
  readonly processId?: number;
  readonly processStartedAt?: string;
  readonly windowClass?: string;
};
export interface DesktopConsentRequest {
  task: string;
  generation: number;
  purpose: "input" | "transmission";
  action?: DesktopAction;
  artifactId?: string;
  destination?: DesktopTransmissionDestination;
  captureScope?: DesktopCaptureScope;
}

export function windowCaptureScope(
  monitor: DesktopMonitor,
  window: DesktopWindow,
): DesktopCaptureScope {
  const b = window.bounds;
  if (
    !b ||
    ![b.x, b.y, b.width, b.height, monitor.x, monitor.y, monitor.width, monitor.height].every(
      Number.isSafeInteger,
    ) ||
    b.width <= 0 ||
    b.height <= 0 ||
    b.width > 16384 ||
    b.height > 16384 ||
    b.width * b.height > 32_000_000 ||
    typeof window.processId !== "number" ||
    !Number.isSafeInteger(window.processId) ||
    window.processId <= 0 ||
    !window.processStartedAt ||
    !/^\d{1,20}$/u.test(window.processStartedAt) ||
    !window.windowClass ||
    window.windowClass.length > 256 ||
    !window.focused
  )
    throw new Error("Selected window identity, focus or bounds unavailable.");
  const x = Math.max(monitor.x, b.x),
    y = Math.max(monitor.y, b.y);
  const width = Math.min(monitor.x + monitor.width, b.x + b.width) - x;
  const height = Math.min(monitor.y + monitor.height, b.y + b.height) - y;
  if (width <= 0 || height <= 0) throw new Error("Selected window is outside selected monitor.");
  return {
    monitorId: monitor.id,
    x,
    y,
    width,
    height,
    windowId: window.id,
    windowBounds: { ...b },
    processId: window.processId,
    processStartedAt: window.processStartedAt,
    windowClass: window.windowClass,
  };
}
export function sameDesktopWindow(left: DesktopWindow, right: DesktopWindow): boolean {
  return (
    left.id === right.id &&
    left.title === right.title &&
    left.processId === right.processId &&
    left.processStartedAt === right.processStartedAt &&
    left.windowClass === right.windowClass &&
    left.bounds?.x === right.bounds?.x &&
    left.bounds?.y === right.bounds?.y &&
    left.bounds?.width === right.bounds?.width &&
    left.bounds?.height === right.bounds?.height
  );
}
function sameCaptureScope(
  left: DesktopCaptureScope | undefined,
  right: DesktopCaptureScope,
): boolean {
  return (
    !!left &&
    left.monitorId === right.monitorId &&
    left.x === right.x &&
    left.y === right.y &&
    left.width === right.width &&
    left.height === right.height &&
    left.windowId === right.windowId &&
    left.processId === right.processId &&
    left.processStartedAt === right.processStartedAt &&
    left.windowClass === right.windowClass &&
    left.windowBounds?.x === right.windowBounds?.x &&
    left.windowBounds?.y === right.windowBounds?.y &&
    left.windowBounds?.width === right.windowBounds?.width &&
    left.windowBounds?.height === right.windowBounds?.height
  );
}

/** Explicitly armed local session. A screenshot never reaches inference through this controller. */
export class RuntimeDesktopSession {
  #generation = 0;
  #audit: { time: number; generation: number; event: string; kind?: string }[] = [];
  #record(event: string, kind?: string): void {
    this.#audit.push({
      time: this.#now(),
      generation: this.#generation,
      event,
      ...(kind ? { kind } : {}),
    });
    this.#audit = this.#audit.slice(-100);
  }
  #armed:
    | {
        task: string;
        monitor: DesktopMonitor;
        windowId?: string;
        window?: DesktopWindow;
        expiresAt: number;
        remaining: number;
        controller: AbortController;
      }
    | undefined;
  #artifacts = new Map<string, DesktopCapture>();
  #artifactScopes = new Map<string, DesktopCaptureScope>();
  #observationEpoch = new Map<string, number>();
  #inputEpoch = 0;
  #inventory: { monitors: DesktopMonitor[]; windows: DesktopWindow[] } = {
    monitors: [],
    windows: [],
  };
  #timer: ReturnType<typeof setTimeout> | undefined;
  #busy = false;
  #released = new Set<string>();
  constructor(
    readonly options: {
      driver?: DesktopDriver;
      approve: (request: DesktopConsentRequest, signal: AbortSignal) => Promise<boolean>;
      now?: () => number;
    },
  ) {}
  #now(): number {
    return this.options.now?.() ?? Date.now();
  }
  #expire(): void {
    if (this.#armed && this.#armed.expiresAt <= this.#now()) this.stop();
  }
  status() {
    this.#expire();
    return {
      state: !this.options.driver ? "disabled" : this.#armed ? "armed" : "idle",
      generation: this.#generation,
      audit: structuredClone(this.#audit),
      monitors: structuredClone(this.#inventory.monitors),
      windows: structuredClone(this.#inventory.windows),
      ...(this.#armed
        ? {
            task: this.#armed.task,
            expiresAt: this.#armed.expiresAt,
            selection: {
              monitorId: this.#armed.monitor.id,
              ...(this.#armed.windowId ? { windowId: this.#armed.windowId } : {}),
            },
            actionsRemaining: this.#armed.remaining,
          }
        : {}),
    };
  }
  async inventory(): Promise<ReturnType<RuntimeDesktopSession["status"]>> {
    if (!this.options.driver) throw new Error("Local desktop driver is disabled.");
    const result = await this.options.driver.inventory(AbortSignal.timeout(10_000));
    if (
      result.monitors.length > 32 ||
      result.windows.length > 200 ||
      !result.monitors.every(
        (m) =>
          [m.x, m.y, m.width, m.height, m.scale].every(Number.isFinite) &&
          m.width > 0 &&
          m.height > 0 &&
          m.width <= 16384 &&
          m.height <= 16384 &&
          m.scale > 0 &&
          m.scale <= 8 &&
          /^[A-Za-z0-9_.:-]{1,100}$/u.test(m.id),
      ) ||
      !result.windows.every((w) => /^[0-9]{1,20}$/u.test(w.id) && w.title.length <= 200)
    )
      throw new Error("Invalid desktop inventory.");
    this.#inventory = structuredClone(result);
    return this.status();
  }
  arm(params: { task: string; monitorId: string; windowId?: string }) {
    if (
      !this.options.driver ||
      typeof params.task !== "string" ||
      !params.task.trim() ||
      Buffer.byteLength(params.task) > 2000
    )
      throw new Error("Invalid desktop task or disabled driver.");
    const monitor = this.#inventory.monitors.find((m) => m.id === params.monitorId);
    if (
      !monitor ||
      (params.windowId && !this.#inventory.windows.some((w) => w.id === params.windowId))
    )
      throw new Error("Select an inventoried monitor/window.");
    this.stop();
    this.#armed = {
      task: params.task,
      monitor: { ...monitor },
      ...(params.windowId
        ? {
            windowId: params.windowId,
            window: structuredClone(this.#inventory.windows.find((w) => w.id === params.windowId)!),
          }
        : {}),
      expiresAt: this.#now() + 120_000,
      remaining: 100,
      controller: new AbortController(),
    };
    this.#timer = setTimeout(() => this.stop(), 120_000);
    this.#timer.unref?.();
    this.#record("armed");
    return this.status();
  }
  stop() {
    this.#generation++;
    this.#record("stopped");
    clearTimeout(this.#timer);
    this.#timer = undefined;
    this.#armed?.controller.abort(new Error("Desktop session stopped."));
    this.#armed = undefined;
    for (const capture of this.#artifacts.values())
      void this.options.driver?.removeCapture(capture).catch(() => undefined);
    this.#artifacts.clear();
    this.#artifactScopes.clear();
    this.#observationEpoch.clear();
    this.#inputEpoch = 0;
    this.#released.clear();
    return this.status();
  }
  #session(generation: number, requireBudget = true) {
    this.#expire();
    if (
      !this.#armed ||
      generation !== this.#generation ||
      (requireBudget && this.#armed.remaining <= 0)
    )
      throw new Error("Desktop session is inactive or stale.");
    return this.#armed;
  }
  async #bounded<T>(signal: AbortSignal, work: () => Promise<T>): Promise<T> {
    signal.throwIfAborted();
    let abort: () => void = () => undefined;
    const cancelled = new Promise<never>((_, reject) => {
      abort = () => reject(new Error("Desktop action cancelled."));
      signal.addEventListener("abort", abort, { once: true });
    });
    try {
      const value = await Promise.race([work(), cancelled]);
      signal.throwIfAborted();
      return value;
    } finally {
      signal.removeEventListener("abort", abort);
    }
  }
  async capture(generation: number) {
    const session = this.#session(generation);
    if (this.#busy || this.#artifacts.size >= 10)
      throw new Error("Desktop session is busy or capture budget exhausted.");
    this.#busy = true;
    session.remaining--;
    try {
      let scope: DesktopCaptureScope = {
        monitorId: session.monitor.id,
        x: session.monitor.x,
        y: session.monitor.y,
        width: session.monitor.width,
        height: session.monitor.height,
      };
      const capture = await this.#bounded(session.controller.signal, async () => {
        const driver = this.options.driver!;
        let image: DesktopCapture;
        if (session.window) {
          if (!driver.captureWindow)
            throw new Error(
              "Selected window capture is unavailable; monitor fallback is forbidden.",
            );
          const inventory = await driver.inventory(session.controller.signal);
          const currentMonitor = inventory.monitors.find((m) => m.id === session.monitor.id);
          const currentWindow = inventory.windows.find((w) => w.id === session.window!.id);
          if (
            !currentMonitor ||
            currentMonitor.x !== session.monitor.x ||
            currentMonitor.y !== session.monitor.y ||
            currentMonitor.width !== session.monitor.width ||
            currentMonitor.height !== session.monitor.height ||
            !currentWindow ||
            !sameDesktopWindow(session.window, currentWindow)
          )
            throw new Error("Selected window or monitor identity changed.");
          scope = windowCaptureScope(session.monitor, currentWindow);
          image = await driver.captureWindow(
            currentWindow,
            session.monitor,
            session.controller.signal,
          );
        } else image = await driver.capture(session.monitor, session.controller.signal);
        if (session.controller.signal.aborted || generation !== this.#generation) {
          await driver.removeCapture(image);
          throw new Error("Desktop capture cancelled.");
        }
        if (
          image.width !== scope.width ||
          image.height !== scope.height ||
          (session.window && !sameCaptureScope(image.scope, scope))
        ) {
          await driver.removeCapture(image);
          throw new Error("Unexpected desktop capture dimensions or scope.");
        }
        return image;
      });
      this.#session(generation, false);
      const artifactId = randomUUID();
      this.#artifacts.set(artifactId, capture);
      this.#artifactScopes.set(artifactId, Object.freeze(structuredClone(scope)));
      this.#observationEpoch.set(artifactId, this.#inputEpoch);
      this.#record("local-capture");
      return {
        artifactId,
        width: capture.width,
        height: capture.height,
        captureScope: structuredClone(scope),
      };
    } finally {
      this.#busy = false;
    }
  }
  async act(
    generation: number,
    action: DesktopAction,
    authorized: () => boolean = () => true,
  ): Promise<void> {
    const session = this.#session(generation);
    if (!authorized()) throw new Error("Desktop invocation scope expired.");
    if (this.#busy) throw new Error("Desktop session is busy.");
    const snapshot = structuredClone(action);
    const keys =
      snapshot.kind === "observed-click"
        ? ["kind", "artifactId", "x", "y"]
        : snapshot.kind === "move" || snapshot.kind === "click"
          ? ["kind", "x", "y"]
          : snapshot.kind === "key"
            ? ["kind", "key"]
            : snapshot.kind === "text"
              ? ["kind", "text"]
              : ["kind", "windowId"];
    if (Object.keys(snapshot).some((key) => !keys.includes(key)))
      throw new Error("Unsupported desktop action field.");
    if (
      snapshot.kind === "move" ||
      snapshot.kind === "click" ||
      snapshot.kind === "observed-click"
    ) {
      const m = session.monitor;
      if (
        !Number.isInteger(snapshot.x) ||
        !Number.isInteger(snapshot.y) ||
        snapshot.x < m.x ||
        snapshot.y < m.y ||
        snapshot.x >= m.x + m.width ||
        snapshot.y >= m.y + m.height
      )
        throw new Error("Input is outside selected monitor.");
      if (snapshot.kind === "observed-click") {
        const scope = this.#artifactScopes.get(snapshot.artifactId);
        const latest = [...this.#artifacts.keys()].at(-1);
        if (
          !scope ||
          latest !== snapshot.artifactId ||
          this.#observationEpoch.get(snapshot.artifactId) !== this.#inputEpoch ||
          snapshot.x < scope.x ||
          snapshot.y < scope.y ||
          snapshot.x >= scope.x + scope.width ||
          snapshot.y >= scope.y + scope.height
        )
          throw new Error("Desktop screenshot is stale or input is outside the observed frame.");
      }
    } else if (snapshot.kind === "text") {
      if (
        typeof snapshot.text !== "string" ||
        Buffer.byteLength(snapshot.text) > 2000 ||
        /[\x00-\x1f\x7f]/u.test(snapshot.text)
      )
        throw new Error("Invalid desktop text.");
    } else if (snapshot.kind === "focus") {
      if (snapshot.windowId !== session.windowId)
        throw new Error("Only the selected window may be focused.");
    } else if (
      snapshot.kind !== "key" ||
      ![
        "Tab",
        "Escape",
        "Enter",
        "Backspace",
        "ArrowUp",
        "ArrowDown",
        "ArrowLeft",
        "ArrowRight",
      ].includes(snapshot.key)
    )
      throw new Error("Unsupported desktop action.");
    if ((snapshot.kind === "key" || snapshot.kind === "text") && !session.windowId)
      throw new Error("Select a window before keyboard input.");
    this.#busy = true;
    try {
      if (
        !(await this.#bounded(session.controller.signal, () =>
          this.options.approve(
            { task: session.task, generation, purpose: "input", action: snapshot },
            session.controller.signal,
          ),
        ))
      )
        throw new Error("Desktop input declined.");
      this.#session(generation);
      if (!authorized()) throw new Error("Desktop invocation scope expired.");
      this.#record("input-approved", snapshot.kind);
      session.remaining--;
      if (session.windowId && (snapshot.kind === "key" || snapshot.kind === "text"))
        await this.#bounded(session.controller.signal, () =>
          this.options.driver!.act(
            { kind: "focus", windowId: session.windowId! },
            session.controller.signal,
          ),
        );
      if (!authorized()) throw new Error("Desktop invocation scope expired.");
      if (snapshot.kind === "observed-click") {
        // Coordinates are bound to the latest screenshot and its actual capture
        // rectangle, not just a model-invented screen position. Recheck the
        // selected target *after* the user approves this exact action.
        if (
          !this.#artifacts.has(snapshot.artifactId) ||
          this.#observationEpoch.get(snapshot.artifactId) !== this.#inputEpoch ||
          [...this.#artifacts.keys()].at(-1) !== snapshot.artifactId
        )
          throw new Error("Desktop observation expired.");
        const inventory = await this.#bounded(session.controller.signal, () =>
          this.options.driver!.inventory(session.controller.signal),
        );
        const monitor = inventory.monitors.find((item) => item.id === session.monitor.id);
        if (
          !monitor ||
          monitor.x !== session.monitor.x ||
          monitor.y !== session.monitor.y ||
          monitor.width !== session.monitor.width ||
          monitor.height !== session.monitor.height
        )
          throw new Error("Observed monitor changed.");
        if (session.window) {
          const current = inventory.windows.find((item) => item.id === session.window!.id);
          if (!current || !current.focused || !sameDesktopWindow(session.window, current))
            throw new Error("Observed window changed.");
          const scope = windowCaptureScope(session.monitor, current);
          if (!sameCaptureScope(this.#artifactScopes.get(snapshot.artifactId), scope))
            throw new Error("Observed capture scope changed.");
        }
      }
      const driverAction: DesktopAction =
        snapshot.kind === "observed-click"
          ? { kind: "click", x: snapshot.x, y: snapshot.y }
          : snapshot;
      await this.#bounded(session.controller.signal, () =>
        this.options.driver!.act(driverAction, session.controller.signal),
      );
      this.#inputEpoch++;
    } finally {
      this.#busy = false;
    }
  }
  /** Host-only access for an authenticated same-origin local preview; never inference. */
  previewArtifact(generation: number, artifactId: string): DesktopCapture {
    this.#session(generation, false);
    const artifact = this.#artifacts.get(artifactId);
    if (!artifact) throw new Error("Unknown local screenshot.");
    return { ...artifact };
  }
  /** Host-only artifact retrieval requires separate transmission consent. Do not expose localPath through RPC. */
  async approveTransmission(
    generation: number,
    artifactId: string,
    confirmTransmission: boolean,
    destination?: DesktopTransmissionDestination,
  ): Promise<DesktopCapture> {
    const session = this.#session(generation, false);
    const artifact = this.#artifacts.get(artifactId);
    if (
      !destination ||
      Object.keys(destination).some(
        (key) =>
          !["runId", "sessionId", "modelId", "accountId", "maxUses", "expiresAtMs"].includes(key),
      ) ||
      ![destination.runId, destination.sessionId, destination.modelId].every(
        (value) =>
          typeof value === "string" &&
          value.length > 0 &&
          value.length <= 200 &&
          !/[\x00-\x1f\x7f]/.test(value),
      ) ||
      !(
        destination.accountId === null ||
        (typeof destination.accountId === "string" &&
          destination.accountId.length > 0 &&
          destination.accountId.length <= 200)
      ) ||
      !Number.isInteger(destination.maxUses) ||
      destination.maxUses < 1 ||
      destination.maxUses > 8 ||
      !Number.isSafeInteger(destination.expiresAtMs) ||
      destination.expiresAtMs <= this.#now() ||
      destination.expiresAtMs > session.expiresAt
    )
      throw new Error("Explicit current-turn screenshot destination required.");
    const destinationSnapshot = Object.freeze({ ...destination });
    if (confirmTransmission !== true || !artifact || this.#released.has(artifactId))
      throw new Error("Explicit screenshot transmission consent required.");
    if (
      !(await this.#bounded(session.controller.signal, () =>
        this.options.approve(
          {
            task: session.task,
            generation,
            purpose: "transmission",
            artifactId,
            destination: destinationSnapshot,
            captureScope: this.#artifactScopes.get(artifactId)!,
          },
          session.controller.signal,
        ),
      ))
    )
      throw new Error("Screenshot transmission declined.");
    this.#session(generation, false);
    if (this.#released.has(artifactId))
      throw new Error("Screenshot transmission consent already used.");
    this.#released.add(artifactId);
    this.#record("transmission-approved");
    return { ...artifact };
  }
}

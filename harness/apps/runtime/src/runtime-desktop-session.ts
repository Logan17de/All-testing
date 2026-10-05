import { randomUUID } from "node:crypto";

export interface DesktopMonitor {
  id: string;
  x: number;
  y: number;
  width: number;
  height: number;
  scale: number;
}
export interface DesktopWindow {
  id: string;
  title: string;
}
export type DesktopAction =
  | { kind: "move" | "click"; x: number; y: number }
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
}
export interface DesktopDriver {
  inventory(signal: AbortSignal): Promise<{ monitors: DesktopMonitor[]; windows: DesktopWindow[] }>;
  capture(monitor: DesktopMonitor, signal: AbortSignal): Promise<DesktopCapture>;
  act(action: DesktopAction, signal: AbortSignal): Promise<void>;
  removeCapture(capture: DesktopCapture): Promise<void>;
}
export interface DesktopConsentRequest {
  task: string;
  generation: number;
  purpose: "input" | "transmission";
  action?: DesktopAction;
  artifactId?: string;
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
        expiresAt: number;
        remaining: number;
        controller: AbortController;
      }
    | undefined;
  #artifacts = new Map<string, DesktopCapture>();
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
      ...(params.windowId ? { windowId: params.windowId } : {}),
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
      const capture = await this.#bounded(session.controller.signal, async () => {
        const image = await this.options.driver!.capture(
          session.monitor,
          session.controller.signal,
        );
        if (session.controller.signal.aborted || generation !== this.#generation) {
          await this.options.driver!.removeCapture(image);
          throw new Error("Desktop capture cancelled.");
        }
        if (image.width !== session.monitor.width || image.height !== session.monitor.height) {
          await this.options.driver!.removeCapture(image);
          throw new Error("Unexpected desktop capture dimensions.");
        }
        return image;
      });
      this.#session(generation, false);
      const artifactId = randomUUID();
      this.#artifacts.set(artifactId, capture);
      this.#record("local-capture");
      return { artifactId, width: capture.width, height: capture.height };
    } finally {
      this.#busy = false;
    }
  }
  async act(generation: number, action: DesktopAction): Promise<void> {
    const session = this.#session(generation);
    if (this.#busy) throw new Error("Desktop session is busy.");
    const snapshot = structuredClone(action);
    const keys =
      snapshot.kind === "move" || snapshot.kind === "click"
        ? ["kind", "x", "y"]
        : snapshot.kind === "key"
          ? ["kind", "key"]
          : snapshot.kind === "text"
            ? ["kind", "text"]
            : ["kind", "windowId"];
    if (Object.keys(snapshot).some((key) => !keys.includes(key)))
      throw new Error("Unsupported desktop action field.");
    if (snapshot.kind === "move" || snapshot.kind === "click") {
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
      this.#record("input-approved", snapshot.kind);
      session.remaining--;
      if (session.windowId && (snapshot.kind === "key" || snapshot.kind === "text"))
        await this.#bounded(session.controller.signal, () =>
          this.options.driver!.act(
            { kind: "focus", windowId: session.windowId! },
            session.controller.signal,
          ),
        );
      await this.#bounded(session.controller.signal, () =>
        this.options.driver!.act(snapshot, session.controller.signal),
      );
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
  ): Promise<DesktopCapture> {
    const session = this.#session(generation, false);
    const artifact = this.#artifacts.get(artifactId);
    if (confirmTransmission !== true || !artifact || this.#released.has(artifactId))
      throw new Error("Explicit screenshot transmission consent required.");
    if (
      !(await this.#bounded(session.controller.signal, () =>
        this.options.approve(
          { task: session.task, generation, purpose: "transmission", artifactId },
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

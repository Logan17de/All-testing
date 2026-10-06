import { randomUUID } from "node:crypto";
import { BrowserDomainPolicy, type BrowserPinnedAddress } from "./runtime-browser-policy.js";

export type BrowserAction =
  | { kind: "navigate"; url: string }
  | { kind: "read"; selector: string }
  | { kind: "click"; selector: string }
  | { kind: "type"; selector: string; text: string }
  | { kind: "key"; key: string }
  | { kind: "capture" };
export interface BrowserCapture {
  id: string;
  width: number;
  height: number;
}
export interface RuntimeBrowserDriver {
  execute(
    this: void,
    action: BrowserAction,
    signal: AbortSignal,
  ): Promise<string | BrowserCapture | null>;
  close(): Promise<void>;
}
export interface BrowserScope {
  permits(url: string): boolean;
  pin(): Promise<BrowserPinnedAddress[]>;
}
export interface BrowserInputApproval {
  id: string;
  generation: number;
  task: string;
  action: BrowserAction;
}
export interface RuntimeBrowserSessionOptions {
  createDriver(options: {
    scope: BrowserScope;
    pins: BrowserPinnedAddress[];
    signal: AbortSignal;
  }): Promise<RuntimeBrowserDriver>;
  approve(request: BrowserInputApproval, signal: AbortSignal): Promise<boolean>;
  /** Trusted host injection for isolated fixtures; never populated from HTTP requests. */
  createScope?: (domains: string[]) => BrowserScope;
  now?: () => number;
}
const keys = new Set([
  "Tab",
  "Escape",
  "Enter",
  "Backspace",
  "ArrowUp",
  "ArrowDown",
  "ArrowLeft",
  "ArrowRight",
  "Home",
  "End",
  "PageUp",
  "PageDown",
]);
function bounded(value: unknown, limit: number): value is string {
  return (
    typeof value === "string" &&
    value.length > 0 &&
    Buffer.byteLength(value) <= limit &&
    !value.includes("\0")
  );
}
function checkedAction(value: BrowserAction): BrowserAction {
  const allowed = {
    navigate: ["kind", "url"],
    read: ["kind", "selector"],
    click: ["kind", "selector"],
    type: ["kind", "selector", "text"],
    key: ["kind", "key"],
    capture: ["kind"],
  };
  if (
    !value ||
    typeof value !== "object" ||
    !(value.kind in allowed) ||
    Object.keys(value).some((key) => !allowed[value.kind].includes(key))
  )
    throw new Error("Invalid browser action");
  if ("selector" in value && !bounded(value.selector, 512))
    throw new Error("Invalid browser selector");
  if (value.kind === "navigate" && !bounded(value.url, 4096))
    throw new Error("Invalid browser URL");
  if (value.kind === "type" && !bounded(value.text, 4096)) throw new Error("Invalid browser input");
  if (value.kind === "key" && !keys.has(value.key)) throw new Error("Unsupported browser key");
  return structuredClone(value);
}
function abortable<T>(operation: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) return Promise.reject(new Error("Browser session stopped"));
  return new Promise<T>((resolve, reject) => {
    const abort = () => reject(new Error("Browser session stopped"));
    signal.addEventListener("abort", abort, { once: true });
    operation
      .then(resolve, reject)
      .finally(() => signal.removeEventListener("abort", abort))
      .catch(() => undefined);
  });
}

/** Ephemeral task authority: no cookies, profiles, credentials or persistent consent. */
export class RuntimeBrowserSession {
  #generation = 0;
  #controller: AbortController | undefined;
  #driver: RuntimeBrowserDriver | undefined;
  #scope: BrowserScope | undefined;
  #timer?: ReturnType<typeof setTimeout>;
  #task = "";
  #expiresAt = 0;
  #remaining = 0;
  #busy = false;
  #armPending = false;
  #captures: BrowserCapture[] = [];
  constructor(private readonly options: RuntimeBrowserSessionOptions) {}
  status() {
    if (this.#controller && this.#now() >= this.#expiresAt) void this.stop().catch(() => undefined);
    return {
      generation: this.#generation,
      armed: !!this.#driver && !this.#controller?.signal.aborted,
      task: this.#task,
      expiresAt: this.#expiresAt,
      remainingActions: this.#remaining,
      captures: this.#captures.map((item) => ({ ...item })),
      captureSharing: "disabled" as const,
    };
  }
  #now() {
    return this.options.now?.() ?? Date.now();
  }
  async arm(input: {
    task: string;
    domains: string[];
    minutes: number;
    maxActions: number;
    confirm: true;
  }) {
    if (this.#armPending) throw new Error("Browser launch already pending");
    this.#armPending = true;
    try {
      return await this.#arm(input);
    } finally {
      this.#armPending = false;
    }
  }
  async #arm(input: {
    task: string;
    domains: string[];
    minutes: number;
    maxActions: number;
    confirm: true;
  }) {
    if (
      !input ||
      Object.keys(input).some(
        (key) => !["task", "domains", "minutes", "maxActions", "confirm"].includes(key),
      ) ||
      input.confirm !== true ||
      !bounded(input.task, 2048) ||
      !Array.isArray(input.domains) ||
      !input.domains.every((item) => typeof item === "string") ||
      !Number.isInteger(input.minutes) ||
      input.minutes < 1 ||
      input.minutes > 15 ||
      !Number.isInteger(input.maxActions) ||
      input.maxActions < 1 ||
      input.maxActions > 100
    )
      throw new Error("Explicit bounded browser scope is required");
    await this.stop();
    const generation = this.#generation;
    const controller = new AbortController();
    this.#controller = controller;
    this.#task = input.task;
    this.#remaining = input.maxActions;
    this.#expiresAt = this.#now() + input.minutes * 60_000;
    this.#timer = setTimeout(() => void this.stop().catch(() => undefined), input.minutes * 60_000);
    this.#timer.unref();
    try {
      const scope =
        this.options.createScope?.(input.domains) ??
        new BrowserDomainPolicy({ domains: input.domains });
      this.#scope = scope;
      const pins = await abortable(scope.pin(), controller.signal);
      const launching = this.options.createDriver({ scope, pins, signal: controller.signal });
      void launching.then(
        (driver) => {
          if (controller.signal.aborted || generation !== this.#generation)
            void driver.close().catch(() => undefined);
        },
        () => undefined,
      );
      const driver = await abortable(launching, controller.signal);
      if (generation !== this.#generation || controller.signal.aborted)
        throw new Error("Browser session stopped");
      this.#driver = driver;
      return this.status();
    } catch {
      if (generation === this.#generation) await this.stop();
      throw new Error("Browser unavailable or scope refused");
    }
  }
  async execute(input: BrowserAction, generation: number) {
    const action = checkedAction(input);
    if (
      generation !== this.#generation ||
      !this.status().armed ||
      !this.#driver ||
      !this.#controller ||
      !this.#scope
    )
      throw new Error("Browser session is not armed");
    if (this.#busy || this.#remaining <= 0) throw new Error("Browser action budget unavailable");
    if (action.kind === "navigate" && !this.#scope.permits(action.url))
      throw new Error("URL outside browser scope");
    if (action.kind === "capture" && this.#captures.length >= 10)
      throw new Error("Browser capture limit reached");
    const controller = this.#controller;
    const driver = this.#driver;
    this.#busy = true;
    this.#remaining--;
    try {
      if (["click", "type", "key"].includes(action.kind)) {
        const accepted = await abortable(
          this.options.approve(
            { id: randomUUID(), generation, task: this.#task, action: structuredClone(action) },
            controller.signal,
          ),
          controller.signal,
        );
        if (!accepted) throw new Error("Browser input declined");
      }
      if (generation !== this.#generation || controller.signal.aborted)
        throw new Error("Browser session stopped");
      const result = await abortable(driver.execute(action, controller.signal), controller.signal);
      if (generation !== this.#generation || controller.signal.aborted)
        throw new Error("Browser session stopped");
      if (typeof result === "string" && Buffer.byteLength(result) > 65536)
        throw new Error("Browser output exceeded limit");
      if (action.kind === "capture" && result && typeof result === "object") {
        if (
          !bounded(result.id, 128) ||
          !Number.isInteger(result.width) ||
          !Number.isInteger(result.height) ||
          result.width < 1 ||
          result.width > 1920 ||
          result.height < 1 ||
          result.height > 1080
        )
          throw new Error("Invalid browser capture");
        this.#captures.push({ id: result.id, width: result.width, height: result.height });
      }
      return result;
    } finally {
      if (generation === this.#generation) this.#busy = false;
    }
  }
  async stop() {
    this.#generation++;
    this.#controller?.abort();
    clearTimeout(this.#timer);
    const driver = this.#driver;
    this.#driver = undefined;
    this.#controller = undefined;
    this.#scope = undefined;
    this.#task = "";
    this.#remaining = 0;
    this.#expiresAt = 0;
    this.#busy = false;
    this.#captures = [];
    await driver?.close().catch(() => undefined);
  }
}

import { resolve } from "node:path";
import {
  RuntimeBrowserSession,
  type RuntimeBrowserSessionOptions,
  type BrowserInputApproval,
  type BrowserAction,
} from "./runtime-browser-session.js";

function exact(value: Record<string, unknown>, fields: string[]) {
  if (Object.keys(value).some((key) => !fields.includes(key)))
    throw new Error("Invalid browser parameters");
}
export class RuntimeBrowserService {
  readonly session: RuntimeBrowserSession;
  #root: string | undefined;
  #pending = new Map<
    string,
    { request: BrowserInputApproval; settle: (accepted: boolean) => void }
  >();
  constructor(
    private readonly options: Omit<RuntimeBrowserSessionOptions, "approve"> & { cwd: () => string },
  ) {
    this.session = new RuntimeBrowserSession({
      ...options,
      approve: (request, signal) =>
        new Promise<boolean>((settle) => {
          const finish = (accepted: boolean) => {
            clearTimeout(timer);
            signal.removeEventListener("abort", abort);
            this.#pending.delete(request.id);
            settle(accepted);
          };
          const abort = () => finish(false);
          const timer = setTimeout(() => finish(false), 30_000);
          timer.unref();
          this.#pending.set(request.id, { request, settle: finish });
          signal.addEventListener("abort", abort, { once: true });
          if (signal.aborted) finish(false);
        }),
    });
  }
  #sync() {
    const root = resolve(this.options.cwd());
    if (this.#root !== undefined && this.#root !== root)
      void this.session.stop().catch(() => undefined);
    this.#root = root;
  }
  snapshot() {
    this.#sync();
    return {
      ...this.session.status(),
      pendingInputs: [...this.#pending.values()].map((entry) => structuredClone(entry.request)),
      capabilities: {
        browserWindow: true,
        desktop: false,
        persistentProfiles: false,
        sharing: false,
        osNetworkFirewall: false,
        mutationRequests: false,
      },
    };
  }
  async action(action: string, params: Record<string, unknown>) {
    this.#sync();
    if (action === "arm") {
      exact(params, ["task", "domains", "minutes", "maxActions", "confirm"]);
      return await this.session.arm(
        params as unknown as Parameters<RuntimeBrowserSession["arm"]>[0],
      );
    }
    if (action === "stop") {
      exact(params, []);
      await this.session.stop();
      return this.snapshot();
    }
    if (action === "execute") {
      exact(params, ["generation", "input"]);
      if (
        !Number.isSafeInteger(params["generation"]) ||
        !params["input"] ||
        typeof params["input"] !== "object" ||
        Array.isArray(params["input"])
      )
        throw new Error("Invalid browser execution");
      return await this.session.execute(
        params["input"] as BrowserAction,
        params["generation"] as number,
      );
    }
    if (action === "approval/respond") {
      exact(params, ["id", "generation", "decision"]);
      if (
        typeof params["id"] !== "string" ||
        !["approved", "rejected"].includes(params["decision"] as string)
      )
        throw new Error("Invalid browser approval");
      const pending = this.#pending.get(params["id"]);
      if (
        !pending ||
        pending.request.generation !== params["generation"] ||
        this.session.status().generation !== params["generation"]
      )
        throw new Error("Expired browser approval");
      pending.settle(params["decision"] === "approved");
      return { accepted: true };
    }
    throw new Error("Unsupported browser action");
  }
  async close() {
    await this.session.stop();
  }
}

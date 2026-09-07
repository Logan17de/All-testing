import {
  RuntimeHttpServer,
  type RuntimeHttpServerOptions,
  type RuntimeHttpServerSnapshot,
} from "./runtime-http-server.js";

export type RuntimeDaemonState = "idle" | "running" | "stopped";

export interface RuntimeDaemonOptions {
  readonly api?: RuntimeHttpServerOptions;
}

export interface RuntimeDaemonSnapshot {
  readonly state: RuntimeDaemonState;
  readonly api: RuntimeHttpServerSnapshot;
}

/**
 * Long-lived runtime lifecycle.
 *
 * Phase 4.2 makes the loopback HTTP server the first real event-loop owner. SQLite,
 * scheduler ownership, SSE, plugins, and permissions remain later Phase 4 concerns.
 */
export class RuntimeDaemon {
  private state: RuntimeDaemonState = "idle";
  private readonly httpServer: RuntimeHttpServer;
  private readonly stoppedPromise: Promise<void>;
  private readonly resolveStopped: () => void;
  private stopPromise: Promise<boolean> | undefined;

  constructor(options: RuntimeDaemonOptions = {}) {
    this.httpServer = new RuntimeHttpServer(options.api);

    let resolveStopped!: () => void;
    this.stoppedPromise = new Promise<void>((resolve) => {
      resolveStopped = resolve;
    });
    this.resolveStopped = resolveStopped;
  }

  snapshot(): RuntimeDaemonSnapshot {
    return Object.freeze({
      state: this.state,
      api: this.httpServer.snapshot(),
    });
  }

  /** Start the daemon only after its loopback API has successfully bound. */
  async start(): Promise<boolean> {
    if (this.state === "stopped") {
      throw new TypeError("Runtime daemon cannot restart after it has stopped.");
    }
    if (this.state === "running") {
      return false;
    }

    await this.httpServer.start();
    this.state = "running";
    return true;
  }

  /** Stop once, closing the API listener before releasing lifecycle waiters. */
  async stop(): Promise<boolean> {
    if (this.state === "stopped") {
      return false;
    }
    if (this.stopPromise !== undefined) {
      await this.stopPromise;
      return false;
    }

    this.stopPromise = this.stopOnce();
    return this.stopPromise;
  }

  waitUntilStopped(): Promise<void> {
    return this.stoppedPromise;
  }

  private async stopOnce(): Promise<boolean> {
    await this.httpServer.stop();
    this.state = "stopped";
    this.resolveStopped();
    return true;
  }
}

const BOOTSTRAP_KEEP_ALIVE_MS = 2_147_483_647;

export type RuntimeDaemonState = "idle" | "running" | "stopped";

export interface RuntimeDaemonSnapshot {
  readonly state: RuntimeDaemonState;
}

/**
 * Minimal long-lived runtime lifecycle for Phase 4.1.
 *
 * The referenced timer is intentionally only a bootstrap event-loop handle. Phase
 * 4.2 replaces its keep-alive role with the loopback HTTP server; persistence and
 * execution ownership remain later Phase 4 concerns.
 */
export class RuntimeDaemon {
  private state: RuntimeDaemonState = "idle";
  private keepAliveTimer: NodeJS.Timeout | undefined;
  private readonly stoppedPromise: Promise<void>;
  private readonly resolveStopped: () => void;

  constructor() {
    let resolveStopped!: () => void;
    this.stoppedPromise = new Promise<void>((resolve) => {
      resolveStopped = resolve;
    });
    this.resolveStopped = resolveStopped;
  }

  snapshot(): RuntimeDaemonSnapshot {
    return Object.freeze({ state: this.state });
  }

  /** Start this daemon lifecycle exactly once. Repeated calls while running are idempotent. */
  start(): boolean {
    if (this.state === "stopped") {
      throw new TypeError("Runtime daemon cannot restart after it has stopped.");
    }
    if (this.state === "running") {
      return false;
    }

    this.keepAliveTimer = setInterval(() => undefined, BOOTSTRAP_KEEP_ALIVE_MS);
    this.state = "running";
    return true;
  }

  /** Stop the lifecycle once and release its event-loop keep-alive handle. */
  stop(): boolean {
    if (this.state === "stopped") {
      return false;
    }

    if (this.keepAliveTimer !== undefined) {
      clearInterval(this.keepAliveTimer);
      this.keepAliveTimer = undefined;
    }
    this.state = "stopped";
    this.resolveStopped();
    return true;
  }

  waitUntilStopped(): Promise<void> {
    return this.stoppedPromise;
  }
}

import type { ExecutionIrV1 } from "@zet-harness/graph";

export interface ConcurrencyPermit {
  readonly release: () => void;
}

export interface ConcurrencySnapshot {
  readonly limit: number;
  readonly active: number;
  readonly waiting: number;
  readonly available: number;
}

type PermitWaiter = (permit: ConcurrencyPermit) => void;

function assertPositiveSafeInteger(label: string, value: number): void {
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new RangeError(`${label} must be a positive safe integer.`);
  }
}

/**
 * Small FIFO async semaphore built only from native Promises.
 *
 * The semaphore owns admission accounting only. It has no execution, timeout,
 * cancellation, retry, or persistence semantics. Waiter cancellation arrives
 * with run cancellation in 3.9 rather than being invented here.
 */
export class AsyncSemaphore {
  readonly limit: number;

  private active = 0;
  private readonly waiters: PermitWaiter[] = [];
  private waiterHead = 0;

  constructor(limit: number) {
    assertPositiveSafeInteger("Semaphore limit", limit);
    this.limit = limit;
  }

  get activeCount(): number {
    return this.active;
  }

  get waitingCount(): number {
    return this.waiters.length - this.waiterHead;
  }

  get availableCount(): number {
    return Math.max(0, this.limit - this.active);
  }

  acquire(): Promise<ConcurrencyPermit> {
    if (this.active < this.limit && this.waitingCount === 0) {
      this.active += 1;
      return Promise.resolve(this.createPermit());
    }

    return new Promise<ConcurrencyPermit>((resolve) => {
      this.waiters.push(resolve);
    });
  }

  snapshot(): ConcurrencySnapshot {
    return Object.freeze({
      limit: this.limit,
      active: this.activeCount,
      waiting: this.waitingCount,
      available: this.availableCount,
    });
  }

  private createPermit(): ConcurrencyPermit {
    let released = false;

    return Object.freeze({
      release: (): void => {
        if (released) {
          throw new TypeError("Concurrency permit was already released.");
        }
        released = true;
        this.releaseOne();
      },
    });
  }

  private releaseOne(): void {
    if (this.active <= 0) {
      throw new TypeError("Semaphore active count would underflow.");
    }

    const waiter = this.waiters[this.waiterHead];
    if (waiter !== undefined) {
      this.waiterHead += 1;
      if (this.waiterHead === this.waiters.length) {
        this.waiters.length = 0;
        this.waiterHead = 0;
      }

      // The released slot transfers directly to the FIFO waiter, so `active`
      // remains unchanged while ownership moves to the new permit.
      waiter(this.createPermit());
      return;
    }

    this.active -= 1;
  }
}

export interface RunConcurrencySnapshot {
  readonly global: ConcurrencySnapshot;
  readonly run: ConcurrencySnapshot;
}

/**
 * Per-run admission gate sharing one scheduler-global semaphore.
 *
 * A run acquires its local permit before waiting on the global gate. This keeps
 * work already blocked by its per-run ceiling from consuming global capacity.
 */
export class RunConcurrency {
  private readonly runSemaphore: AsyncSemaphore;

  constructor(
    private readonly globalSemaphore: AsyncSemaphore,
    runLimit: number,
  ) {
    this.runSemaphore = new AsyncSemaphore(runLimit);
  }

  get limit(): number {
    return this.runSemaphore.limit;
  }

  get activeCount(): number {
    return this.runSemaphore.activeCount;
  }

  get waitingCount(): number {
    return this.runSemaphore.waitingCount;
  }

  async acquire(): Promise<ConcurrencyPermit> {
    const runPermit = await this.runSemaphore.acquire();

    try {
      const globalPermit = await this.globalSemaphore.acquire();
      let released = false;

      return Object.freeze({
        release: (): void => {
          if (released) {
            throw new TypeError("Run concurrency permit was already released.");
          }
          released = true;

          // Return the global slot first so other runs can make progress before
          // this run admits more local work.
          globalPermit.release();
          runPermit.release();
        },
      });
    } catch (error) {
      runPermit.release();
      throw error;
    }
  }

  snapshot(): RunConcurrencySnapshot {
    return Object.freeze({
      global: this.globalSemaphore.snapshot(),
      run: this.runSemaphore.snapshot(),
    });
  }
}

/**
 * Scheduler-wide concurrency coordinator.
 *
 * `globalLimit` is runtime-owned. A compiled graph may further restrict one run
 * through IR `policies.maxParallelism`; when omitted, that run inherits the
 * global limit. Separate RunConcurrency instances therefore share one hard
 * global ceiling while keeping independent per-run queues/counters.
 */
export class SchedulerConcurrency {
  private readonly globalSemaphore: AsyncSemaphore;

  constructor(globalLimit: number) {
    this.globalSemaphore = new AsyncSemaphore(globalLimit);
  }

  get globalLimit(): number {
    return this.globalSemaphore.limit;
  }

  snapshot(): ConcurrencySnapshot {
    return this.globalSemaphore.snapshot();
  }

  createRun(ir: Pick<ExecutionIrV1, "policies">): RunConcurrency {
    const runLimit = ir.policies.maxParallelism ?? this.globalLimit;
    assertPositiveSafeInteger("Run maxParallelism", runLimit);
    return new RunConcurrency(this.globalSemaphore, runLimit);
  }
}

import type { SqliteDatabase } from "@zet-harness/db";
import {
  claimTriggerFire,
  recordTriggerFireRun,
} from "@zet-harness/db/durable-trigger-fire-records";
import {
  listTriggers,
  recordTriggerFired,
  rescheduleTrigger,
  type DurableTriggerRecord,
} from "@zet-harness/db/durable-trigger-records";
import { createSortableId } from "@zet-harness/db/sortable-id";

import { nextCronFireAtMs, parseCronExpression } from "./runtime-cron.js";
import { createRunFromStoredPlan } from "./runtime-graphs.js";

export interface RuntimeTriggerSchedulerOptions {
  readonly database: SqliteDatabase;
  /** Wake the dispatcher for a run the schedule started. */
  readonly dispatch?: (runId: string) => void;
  readonly now?: () => number;
  readonly createId?: () => string;
  /**
   * How long the process may sleep when nothing is due. The due time itself lives in
   * the database, so this only bounds how stale the in-process view can be.
   */
  readonly maxSleepMs?: number;
}

export interface TriggerSchedulerPass {
  readonly firedAtMs: number;
  /** Runs this pass started, in the order the triggers were due. */
  readonly runIds: readonly string[];
  /** Triggers that were due but had already been fired for that tick. */
  readonly duplicates: number;
  /** When the next trigger is due, or undefined when none is. */
  readonly nextDueAtMs: number | undefined;
}

const DEFAULT_MAX_SLEEP_MS = 60_000;

/**
 * Fires cron triggers when they come due.
 *
 * No timer carries the schedule: a trigger's next due time is durable state, and the
 * process only ever holds one short timer to the next check. A daemon that was down
 * finds its overdue triggers on the next pass and fires each once — a schedule is a
 * standing intention, not a queue of missed ticks — and each tick is claimed by its
 * due time, so two passes of the same tick start one run.
 */
export class RuntimeTriggerScheduler {
  readonly #database: SqliteDatabase;
  readonly #dispatch: ((runId: string) => void) | undefined;
  readonly #now: () => number;
  readonly #createId: () => string;
  readonly #maxSleepMs: number;
  #timer: NodeJS.Timeout | undefined;
  #running = false;
  #pass: Promise<TriggerSchedulerPass> | undefined;

  constructor(options: RuntimeTriggerSchedulerOptions) {
    this.#database = options.database;
    this.#dispatch = options.dispatch;
    this.#now = options.now ?? (() => Date.now());
    this.#createId = options.createId ?? createSortableId;
    this.#maxSleepMs = options.maxSleepMs ?? DEFAULT_MAX_SLEEP_MS;
  }

  /** Every enabled cron trigger that is due at `nowMs`, earliest first. */
  due(nowMs: number): readonly DurableTriggerRecord[] {
    return listTriggers(this.#database.connection())
      .filter(
        (trigger) =>
          trigger.enabled && trigger.nextFireAtMs !== null && trigger.nextFireAtMs <= nowMs,
      )
      .sort((left, right) => (left.nextFireAtMs ?? 0) - (right.nextFireAtMs ?? 0));
  }

  /** Fire everything due now, and say when the next one is. */
  async tick(): Promise<TriggerSchedulerPass> {
    const firedAtMs = this.#now();
    const runIds: string[] = [];
    let duplicates = 0;

    for (const trigger of this.due(firedAtMs)) {
      const dueAtMs = trigger.nextFireAtMs ?? firedAtMs;
      // The tick's own due time is the dedupe key, so repeating a pass repeats nothing.
      const claim = await this.#database.commit((connection) =>
        claimTriggerFire(connection, {
          fireId: this.#createId(),
          triggerId: trigger.triggerId,
          dedupeKey: `cron:${String(dueAtMs)}`,
          reason: "cron",
          nowMs: firedAtMs,
        }),
      );
      const nextDue = this.#nextDue(trigger, firedAtMs);
      if (claim.duplicate) {
        duplicates += 1;
        // Still move the trigger on, or a duplicate tick would stay due for ever. Its
        // last run is left alone: this pass did not start one.
        await this.#database.commit((connection) => {
          rescheduleTrigger(connection, trigger.triggerId, nextDue, firedAtMs);
        });
        continue;
      }

      const runId = await createRunFromStoredPlan(
        this.#database,
        { documentHash: trigger.documentHash, compiledPlanId: trigger.compiledPlanId },
        firedAtMs,
      );
      await this.#database.commit((connection) => {
        recordTriggerFireRun(connection, claim.fire.fireId, runId);
        recordTriggerFired(connection, trigger.triggerId, runId, firedAtMs, nextDue);
      });
      runIds.push(runId);
      this.#dispatch?.(runId);
    }

    return Object.freeze({
      firedAtMs,
      runIds: Object.freeze(runIds),
      duplicates,
      nextDueAtMs: this.nextDueAtMs(),
    });
  }

  /** When the earliest enabled cron trigger is next due. */
  nextDueAtMs(): number | undefined {
    const times = listTriggers(this.#database.connection())
      .filter((trigger) => trigger.enabled && trigger.nextFireAtMs !== null)
      .map((trigger) => trigger.nextFireAtMs ?? 0);
    return times.length === 0 ? undefined : Math.min(...times);
  }

  /** Start checking. Anything already overdue fires on the first pass. */
  start(): void {
    if (this.#running) return;
    this.#running = true;
    this.#schedule(0);
  }

  async stop(): Promise<void> {
    this.#running = false;
    if (this.#timer !== undefined) clearTimeout(this.#timer);
    this.#timer = undefined;
    await this.#pass;
  }

  #nextDue(trigger: DurableTriggerRecord, firedAtMs: number): number | null {
    if (trigger.cronExpression === null) return null;
    try {
      return nextCronFireAtMs(parseCronExpression(trigger.cronExpression), firedAtMs) ?? null;
    } catch {
      // A schedule that no longer parses stops rather than firing every pass.
      return null;
    }
  }

  #schedule(delayMs: number): void {
    if (!this.#running) return;
    this.#timer = setTimeout(() => {
      this.#timer = undefined;
      if (!this.#running) return;
      this.#pass = this.tick();
      void this.#pass
        .then((pass) => {
          const wait =
            pass.nextDueAtMs === undefined
              ? this.#maxSleepMs
              : Math.min(this.#maxSleepMs, Math.max(0, pass.nextDueAtMs - this.#now()));
          this.#schedule(wait);
        })
        .catch(() => {
          // A failed pass must not stop the schedule; the next one tries again.
          this.#schedule(this.#maxSleepMs);
        });
    }, delayMs);
    // The schedule must never be the reason the process stays alive.
    this.#timer.unref();
  }
}

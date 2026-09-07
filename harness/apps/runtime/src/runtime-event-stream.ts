export const DEFAULT_RUNTIME_EVENT_REPLAY_CAPACITY = 256;

export interface RuntimeStreamEvent {
  readonly id: number;
  readonly type: string;
  readonly data: string;
}

export interface RuntimeEventStreamSnapshot {
  readonly latestEventId: number;
  readonly oldestRetainedEventId: number | null;
  readonly retainedEvents: number;
  readonly subscribers: number;
}

export interface RuntimeEventStreamOptions {
  readonly replayCapacity?: number;
}

export type RuntimeEventStreamListener = (event: RuntimeStreamEvent) => void;
export type RuntimeEventStreamUnsubscribe = () => void;

export class RuntimeEventCursorError extends RangeError {
  readonly code = "RUNTIME_EVENT_CURSOR_OUT_OF_RANGE";
  readonly cursor: number;
  readonly oldestRetainedEventId: number | null;
  readonly latestEventId: number;

  constructor(cursor: number, oldestRetainedEventId: number | null, latestEventId: number) {
    super(
      `Runtime event cursor ${String(cursor)} is outside the retained range ` +
        `(oldest ${String(oldestRetainedEventId)}, latest ${String(latestEventId)}).`,
    );
    this.name = "RuntimeEventCursorError";
    this.cursor = cursor;
    this.oldestRetainedEventId = oldestRetainedEventId;
    this.latestEventId = latestEventId;
  }
}

const assertCursor = (cursor: number): void => {
  if (!Number.isSafeInteger(cursor) || cursor < 0) {
    throw new TypeError("Runtime event cursor must be a non-negative safe integer.");
  }
};

const assertEventType = (type: string): void => {
  if (type.length === 0 || type.includes("\r") || type.includes("\n")) {
    throw new TypeError("Runtime stream event type must be non-empty and contain no line breaks.");
  }
};

/**
 * Process-local event stream used by the Phase 4.3 SSE transport.
 *
 * IDs are monotonic only for this process lifetime. The replay buffer is bounded
 * and intentionally non-durable; SQLite-backed durable event identity arrives in
 * later Phase 4 items.
 */
export class RuntimeEventStream {
  private readonly replayCapacity: number;
  private readonly retained: RuntimeStreamEvent[] = [];
  private readonly listeners = new Set<RuntimeEventStreamListener>();
  private latestEventId = 0;

  constructor(options: RuntimeEventStreamOptions = {}) {
    this.replayCapacity = options.replayCapacity ?? DEFAULT_RUNTIME_EVENT_REPLAY_CAPACITY;

    if (!Number.isSafeInteger(this.replayCapacity) || this.replayCapacity < 1) {
      throw new TypeError("Runtime event replay capacity must be a positive safe integer.");
    }
  }

  snapshot(): RuntimeEventStreamSnapshot {
    return Object.freeze({
      latestEventId: this.latestEventId,
      oldestRetainedEventId: this.retained[0]?.id ?? null,
      retainedEvents: this.retained.length,
      subscribers: this.listeners.size,
    });
  }

  publish(type: string, data: unknown): RuntimeStreamEvent {
    assertEventType(type);

    const serialized = JSON.stringify(data);
    if (serialized === undefined) {
      throw new TypeError("Runtime stream event data must be JSON-serializable.");
    }

    const nextEventId = this.latestEventId + 1;
    if (!Number.isSafeInteger(nextEventId)) {
      throw new RangeError("Runtime stream event ID exhausted the safe integer range.");
    }

    const event = Object.freeze({
      id: nextEventId,
      type,
      data: serialized,
    });

    this.latestEventId = nextEventId;
    this.retained.push(event);
    if (this.retained.length > this.replayCapacity) {
      this.retained.shift();
    }

    for (const listener of [...this.listeners]) {
      listener(event);
    }

    return event;
  }

  replayAfter(cursor: number): readonly RuntimeStreamEvent[] {
    assertCursor(cursor);

    const oldestRetainedEventId = this.retained[0]?.id ?? null;
    if (cursor > this.latestEventId) {
      throw new RuntimeEventCursorError(cursor, oldestRetainedEventId, this.latestEventId);
    }
    if (oldestRetainedEventId !== null && cursor < oldestRetainedEventId - 1) {
      throw new RuntimeEventCursorError(cursor, oldestRetainedEventId, this.latestEventId);
    }

    return Object.freeze(this.retained.filter((event) => event.id > cursor));
  }

  subscribe(listener: RuntimeEventStreamListener): RuntimeEventStreamUnsubscribe {
    this.listeners.add(listener);
    let active = true;

    return (): void => {
      if (!active) {
        return;
      }
      active = false;
      this.listeners.delete(listener);
    };
  }
}

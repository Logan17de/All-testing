import { randomBytes } from "node:crypto";

/** Largest Unix millisecond timestamp a UUIDv7 can carry (48 bits). */
const MAX_TIMESTAMP_MS = 0xffff_ffff_ffff;
const MAX_COUNTER = 0xfff;

/** Lowercase RFC 9562 UUIDv7 text. */
export const SORTABLE_ID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;

export interface SortableIdGeneratorOptions {
  /** UTC epoch milliseconds. Defaults to the system clock. */
  readonly now?: () => number;
  /** Source of random bytes. Defaults to `crypto.randomBytes`. */
  readonly random?: (size: number) => Uint8Array;
}

/**
 * Time-ordered ids (RFC 9562 UUIDv7).
 *
 * The first 48 bits are the creation time in UTC epoch milliseconds, so ids sort
 * by creation time as plain text, in SQLite and in JavaScript alike. Within one
 * millisecond a 12-bit counter keeps ids from one generator strictly increasing,
 * and a clock that steps backwards reuses the last timestamp rather than
 * breaking the order.
 */
export class SortableIdGenerator {
  private readonly now: () => number;
  private readonly random: (size: number) => Uint8Array;
  private lastMs = -1;
  private counter = 0;

  constructor(options: SortableIdGeneratorOptions = {}) {
    this.now = options.now ?? (() => Date.now());
    this.random = options.random ?? randomBytes;
  }

  next(): string {
    const clock = this.now();
    if (!Number.isSafeInteger(clock) || clock < 0 || clock > MAX_TIMESTAMP_MS) {
      throw new RangeError("Sortable ids need a clock reading in UTC epoch milliseconds.");
    }
    let timestamp = clock;
    if (timestamp > this.lastMs) {
      const seed = this.random(2);
      // Start in the lower half of the counter so one millisecond has room for many ids.
      this.counter = (((seed[0] ?? 0) << 8) | (seed[1] ?? 0)) & 0x7ff;
    } else {
      timestamp = this.lastMs;
      this.counter += 1;
      if (this.counter > MAX_COUNTER) {
        timestamp += 1;
        this.counter = 0;
      }
      if (timestamp > MAX_TIMESTAMP_MS) {
        throw new RangeError("Sortable ids ran past the largest UUIDv7 timestamp.");
      }
    }
    this.lastMs = timestamp;

    const bytes = new Uint8Array(16);
    let rest = timestamp;
    for (let index = 5; index >= 0; index -= 1) {
      bytes[index] = rest % 256;
      rest = Math.floor(rest / 256);
    }
    bytes[6] = 0x70 | (this.counter >> 8);
    bytes[7] = this.counter & 0xff;
    bytes.set(this.random(8).subarray(0, 8), 8);
    bytes[8] = ((bytes[8] ?? 0) & 0x3f) | 0x80;

    const hex = Buffer.from(bytes).toString("hex");
    return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
  }
}

const processIds = new SortableIdGenerator();

/** A new time-ordered id from the process-wide generator. */
export function createSortableId(): string {
  return processIds.next();
}

/** The creation time an id carries, or undefined when it is not a sortable id. */
export function sortableIdTimestamp(id: string): number | undefined {
  if (!SORTABLE_ID_PATTERN.test(id)) return undefined;
  return Number.parseInt(`${id.slice(0, 8)}${id.slice(9, 13)}`, 16);
}

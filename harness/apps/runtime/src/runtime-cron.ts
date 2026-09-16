/**
 * A small UTC cron evaluator.
 *
 * Five fields — minute, hour, day of month, month, day of week — each `*`, a number,
 * a range, a list, or a step (`*_/5`, `10-30/5`). Day of week is 0-6 with Sunday as 0,
 * and 7 also means Sunday. When both day fields are restricted, a day matches if
 * either does, which is what every other cron does.
 *
 * Times are UTC. A local timezone would need a rule for the hours that repeat or
 * vanish at a daylight-saving change, and a trigger that fires twice or not at all is
 * worse than one that fires at a predictable UTC time.
 */

const FIELD_RANGES: readonly (readonly [number, number])[] = [
  [0, 59],
  [0, 23],
  [1, 31],
  [1, 12],
  [0, 7],
];

export class CronExpressionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CronExpressionError";
  }
}

export interface CronSchedule {
  readonly expression: string;
  readonly minutes: ReadonlySet<number>;
  readonly hours: ReadonlySet<number>;
  readonly daysOfMonth: ReadonlySet<number>;
  readonly months: ReadonlySet<number>;
  readonly daysOfWeek: ReadonlySet<number>;
  /** True when the field was `*`, which makes the day rule "either day field". */
  readonly everyDayOfMonth: boolean;
  readonly everyDayOfWeek: boolean;
}

function parseField(field: string, index: number): ReadonlySet<number> {
  const [low, high] = FIELD_RANGES[index]!;
  const values = new Set<number>();
  for (const part of field.split(",")) {
    if (part.length === 0) throw new CronExpressionError(`Empty value in '${field}'.`);
    const [rangePart, stepPart, ...rest] = part.split("/");
    if (rest.length > 0 || rangePart === undefined) {
      throw new CronExpressionError(`'${part}' is not a cron value.`);
    }
    let step = 1;
    if (stepPart !== undefined) {
      step = Number(stepPart);
      if (!Number.isSafeInteger(step) || step < 1) {
        throw new CronExpressionError(`'${part}' needs a whole step of at least 1.`);
      }
    }
    let start = low;
    let end = high;
    if (rangePart !== "*") {
      const [from, to, ...extra] = rangePart.split("-");
      if (extra.length > 0 || from === undefined) {
        throw new CronExpressionError(`'${part}' is not a cron value.`);
      }
      start = Number(from);
      end = to === undefined ? (stepPart === undefined ? start : high) : Number(to);
      if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end)) {
        throw new CronExpressionError(`'${part}' is not a cron value.`);
      }
      if (start < low || end > high || end < start) {
        throw new CronExpressionError(
          `'${part}' is outside ${String(low)}-${String(high)} for this field.`,
        );
      }
    }
    for (let value = start; value <= end; value += step) values.add(value);
  }
  if (values.size === 0) throw new CronExpressionError(`'${field}' matches nothing.`);
  return values;
}

/** Parse a five-field UTC cron expression, or explain why it is not one. */
export function parseCronExpression(expression: string): CronSchedule {
  const fields = expression.trim().split(/\s+/u);
  if (fields.length !== 5) {
    throw new CronExpressionError(
      "A cron expression has five fields: minute, hour, day of month, month, day of week.",
    );
  }
  const [minute, hour, dayOfMonth, month, dayOfWeek] = fields as [
    string,
    string,
    string,
    string,
    string,
  ];
  const daysOfWeek = new Set([...parseField(dayOfWeek, 4)].map((day) => (day === 7 ? 0 : day)));
  return Object.freeze({
    expression: fields.join(" "),
    minutes: parseField(minute, 0),
    hours: parseField(hour, 1),
    daysOfMonth: parseField(dayOfMonth, 2),
    months: parseField(month, 3),
    daysOfWeek,
    everyDayOfMonth: dayOfMonth === "*",
    everyDayOfWeek: dayOfWeek === "*",
  });
}

/** True when this expression is a five-field UTC cron expression. */
export function isCronExpression(expression: string): boolean {
  try {
    parseCronExpression(expression);
    return true;
  } catch {
    return false;
  }
}

const MINUTE_MS = 60_000;
/** Four years covers every 29 February, so a schedule that can fire always will. */
const SEARCH_LIMIT_MINUTES = 4 * 366 * 24 * 60;

function matches(schedule: CronSchedule, date: Date): boolean {
  if (!schedule.minutes.has(date.getUTCMinutes())) return false;
  if (!schedule.hours.has(date.getUTCHours())) return false;
  if (!schedule.months.has(date.getUTCMonth() + 1)) return false;
  const dayOfMonth = schedule.daysOfMonth.has(date.getUTCDate());
  const dayOfWeek = schedule.daysOfWeek.has(date.getUTCDay());
  // Cron's day rule: restrict both fields and either one may match.
  if (schedule.everyDayOfMonth && schedule.everyDayOfWeek) return true;
  if (schedule.everyDayOfMonth) return dayOfWeek;
  if (schedule.everyDayOfWeek) return dayOfMonth;
  return dayOfMonth || dayOfWeek;
}

/**
 * The first time at or after `afterMs` that this schedule fires, in epoch
 * milliseconds, or undefined when it never does within four years.
 */
export function nextCronFireAtMs(schedule: CronSchedule, afterMs: number): number | undefined {
  if (!Number.isSafeInteger(afterMs) || afterMs < 0) {
    throw new CronExpressionError("afterMs must be a non-negative whole number.");
  }
  // Cron fires on the minute, so start at the next whole minute after this one.
  let cursor = Math.floor(afterMs / MINUTE_MS) * MINUTE_MS + MINUTE_MS;
  for (let step = 0; step < SEARCH_LIMIT_MINUTES; step += 1) {
    if (matches(schedule, new Date(cursor))) return cursor;
    cursor += MINUTE_MS;
  }
  return undefined;
}

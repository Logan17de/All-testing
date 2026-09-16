import { describe, expect, it } from "vitest";

import {
  CronExpressionError,
  isCronExpression,
  nextCronFireAtMs,
  parseCronExpression,
} from "./runtime-cron.js";

const at = (iso: string): number => Date.parse(iso);
const next = (expression: string, from: string): string | undefined => {
  const fires = nextCronFireAtMs(parseCronExpression(expression), at(from));
  return fires === undefined ? undefined : new Date(fires).toISOString();
};

describe("the cron evaluator (9.9)", () => {
  it("reads the five fields, including lists, ranges and steps", () => {
    const schedule = parseCronExpression("0,30 9-17 * * 1-5");
    expect([...schedule.minutes]).toEqual([0, 30]);
    expect([...schedule.hours]).toEqual([9, 10, 11, 12, 13, 14, 15, 16, 17]);
    expect([...schedule.daysOfWeek]).toEqual([1, 2, 3, 4, 5]);
    expect(schedule.everyDayOfMonth).toBe(true);
    expect([...parseCronExpression("*/15 * * * *").minutes]).toEqual([0, 15, 30, 45]);
    expect([...parseCronExpression("0 0 * * 7").daysOfWeek]).toEqual([0]);
    expect(parseCronExpression("  5   4 * * *  ").expression).toBe("5 4 * * *");
  });

  it("refuses what is not a cron expression", () => {
    for (const bad of [
      "* * * *",
      "* * * * * *",
      "60 * * * *",
      "* 24 * * *",
      "0 0 32 * *",
      "0 0 * 13 *",
      "0 0 * * 8",
      "*/0 * * * *",
      "10-5 * * * *",
      "a * * * *",
      "",
    ]) {
      expect(() => parseCronExpression(bad), bad).toThrow(CronExpressionError);
      expect(isCronExpression(bad), bad).toBe(false);
    }
    expect(isCronExpression("0 3 * * *")).toBe(true);
  });

  it("finds the next time it fires, in UTC", () => {
    expect(next("*/15 * * * *", "2026-09-16T10:07:00.000Z")).toBe("2026-09-16T10:15:00.000Z");
    // On the minute already: the next one, never the same minute twice.
    expect(next("*/15 * * * *", "2026-09-16T10:15:00.000Z")).toBe("2026-09-16T10:30:00.000Z");
    expect(next("0 3 * * *", "2026-09-16T10:07:00.000Z")).toBe("2026-09-17T03:00:00.000Z");
    expect(next("0 0 1 * *", "2026-09-16T10:07:00.000Z")).toBe("2026-10-01T00:00:00.000Z");
    // Monday after a Wednesday.
    expect(next("30 9 * * 1", "2026-09-16T10:07:00.000Z")).toBe("2026-09-21T09:30:00.000Z");
    expect(next("0 0 29 2 *", "2026-09-16T10:07:00.000Z")).toBe("2028-02-29T00:00:00.000Z");
  });

  it("fires on either day field when both are restricted, as cron does", () => {
    // The 1st of the month, or any Monday.
    expect(next("0 0 1 * 1", "2026-09-16T00:00:00.000Z")).toBe("2026-09-21T00:00:00.000Z");
    expect(next("0 0 1 * 1", "2026-09-22T00:00:00.000Z")).toBe("2026-09-28T00:00:00.000Z");
    expect(next("0 0 1 * 1", "2026-09-29T00:00:00.000Z")).toBe("2026-10-01T00:00:00.000Z");
  });

  it("says when a schedule never comes round, and refuses a bad start", () => {
    // 30 February.
    expect(
      nextCronFireAtMs(parseCronExpression("0 0 30 2 *"), at("2026-01-01T00:00:00.000Z")),
    ).toBe(undefined);
    expect(() => nextCronFireAtMs(parseCronExpression("* * * * *"), -1)).toThrow(
      CronExpressionError,
    );
  });
});

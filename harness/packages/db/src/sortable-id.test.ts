import { describe, expect, it } from "vitest";

import {
  SORTABLE_ID_PATTERN,
  SortableIdGenerator,
  createSortableId,
  sortableIdTimestamp,
} from "./sortable-id.js";

describe("sortable ids", () => {
  it("formats UUIDv7 ids that carry their creation time", () => {
    const id = new SortableIdGenerator({ now: () => 1_726_000_000_123 }).next();

    expect(id).toMatch(SORTABLE_ID_PATTERN);
    expect(sortableIdTimestamp(id)).toBe(1_726_000_000_123);
    expect(createSortableId()).toMatch(SORTABLE_ID_PATTERN);
    expect(sortableIdTimestamp("not-an-id")).toBeUndefined();
  });

  it("keeps one generator's ids in creation order within a millisecond and when the clock steps back", () => {
    let clock = 5_000;
    const generator = new SortableIdGenerator({ now: () => clock });
    const ids: string[] = [];
    for (let index = 0; index < 5_000; index += 1) {
      if (index === 2_500) clock = 4_000;
      if (index === 4_000) clock = 6_000;
      ids.push(generator.next());
    }

    expect([...ids].sort()).toEqual(ids);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("orders ids from different milliseconds by time, whatever their random bits", () => {
    const early = new SortableIdGenerator({
      now: () => 1,
      random: (size) => new Uint8Array(size).fill(0xff),
    }).next();
    const late = new SortableIdGenerator({
      now: () => 2,
      random: (size) => new Uint8Array(size),
    }).next();

    expect(early < late).toBe(true);
  });

  it("refuses a clock reading that is not epoch milliseconds", () => {
    expect(() => new SortableIdGenerator({ now: () => -1 }).next()).toThrow(RangeError);
    expect(() => new SortableIdGenerator({ now: () => 1.5 }).next()).toThrow(RangeError);
  });
});

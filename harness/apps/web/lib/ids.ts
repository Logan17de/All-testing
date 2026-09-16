/**
 * The runtime's id format, as the browser-facing proxy sees it.
 *
 * The daemon mints sortable UUIDv7 ids and refuses anything else. Checking the
 * same shape here keeps a malformed id — or a path segment pretending to be one —
 * from ever reaching the runtime through a proxy route.
 */

export const SORTABLE_ID_SOURCE =
  "[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}";

const SORTABLE_ID = new RegExp(`^${SORTABLE_ID_SOURCE}$`, "u");

export function isSortableId(value: string): boolean {
  return SORTABLE_ID.test(value);
}

import type { SqliteDatabase } from "@zet-harness/db";
import {
  DurableMemoryError,
  MEMORY_BODY_MAX_LENGTH,
  MEMORY_KINDS,
  MEMORY_TITLE_MAX_LENGTH,
  createMemory,
  listMemories,
  readMemory,
  updateMemory,
  type DurableMemoryKind,
  type DurableMemoryRecord,
  type MemoryStatementRunner,
} from "@zet-harness/db/durable-memory-records";
import { createSortableId } from "@zet-harness/db/sortable-id";
import type { JsonObject, ToolAdapter } from "@zet-harness/plugin-api";

import {
  ActionInputError,
  READ_BEHAVIOR,
  SORTABLE_ID_SCHEMA,
  WRITE_BEHAVIOR,
  actionTool,
  createActionRunners,
  invalidInput,
  json,
  objectSchema,
  only,
  optionalBoolean,
  optionalInteger,
  optionalString,
  requiredString,
} from "./runtime-action-tools.js";

/** Tool ids of the model-visible memory actions. */
export const MEMORY_ACTION_TOOL_IDS = Object.freeze({
  listMemories: "harness.memory.list",
  remember: "harness.memory.remember",
  updateMemory: "harness.memory.update",
});

export interface MemoryActionToolOptions {
  readonly database: SqliteDatabase;
  /** Every action is confined to this project; ids from other projects are not found. */
  readonly projectId: string;
  /** The run writing the memory, recorded so a memory says where it came from. */
  readonly runId: string;
  /** UTC epoch milliseconds. Defaults to the system clock. */
  readonly now?: () => number;
  /** Defaults to a sortable UUIDv7. */
  readonly createId?: () => string;
}

const TITLE_SCHEMA = { type: "string", minLength: 1, maxLength: MEMORY_TITLE_MAX_LENGTH };
const BODY_SCHEMA = { type: "string", minLength: 1, maxLength: MEMORY_BODY_MAX_LENGTH };
const KIND_SCHEMA = {
  type: "string",
  enum: [...MEMORY_KINDS],
  description: "Defaults to a plain note.",
};
const PINNED_SCHEMA = {
  type: "boolean",
  description: "A pinned memory is offered first, before recent ones.",
};
const LIMIT_SCHEMA = { type: "integer", minimum: 1, maximum: 100 };
const SEARCH_SCHEMA = {
  type: "string",
  minLength: 1,
  maxLength: 200,
  description: "Only memories whose title or body contains this text, ignoring case.",
};

function isRefusal(error: unknown): error is ActionInputError | DurableMemoryError {
  return error instanceof ActionInputError || error instanceof DurableMemoryError;
}

function kindOf(input: JsonObject): DurableMemoryKind | undefined {
  const value = optionalString(input, "kind");
  if (value === undefined) return undefined;
  if (!(MEMORY_KINDS as readonly string[]).includes(value)) {
    throw invalidInput(`kind must be one of: ${MEMORY_KINDS.join(", ")}.`, "kind");
  }
  return value as DurableMemoryKind;
}

/**
 * What an agent may do with a project's memory.
 *
 * A step is already told what the project remembers; these actions let it look
 * further than the few memories its context budget carried, write down something
 * worth keeping beyond this conversation, and correct or pin what is already there.
 * Every memory it writes is marked as an agent's, naming the run, so a person can
 * always see which memories are the harness's own words.
 *
 * There is deliberately no forgetting here. Forgetting removes a memory outright and
 * nothing keeps a copy, so it stays a person's act: an agent that could delete what a
 * project remembers could quietly erase the reason it was told to stop.
 */
export function createMemoryActionTools(options: MemoryActionToolOptions): readonly ToolAdapter[] {
  const { database, projectId, runId } = options;
  const now = options.now ?? (() => Date.now());
  const createId = options.createId ?? createSortableId;

  const memoryInProject = (
    connection: MemoryStatementRunner,
    memoryId: string,
  ): DurableMemoryRecord => {
    const memory = readMemory(connection, memoryId);
    if (memory === undefined || memory.projectId !== projectId) {
      throw new ActionInputError(
        "MEMORY_NOT_FOUND",
        "No memory with this id is in this project.",
        "memoryId",
      );
    }
    return memory;
  };

  const { read, write } = createActionRunners({
    database,
    projectId,
    now,
    isRefusal,
    savepoint: "memory_action",
  });

  return Object.freeze([
    actionTool(
      MEMORY_ACTION_TOOL_IDS.listMemories,
      "List what the project remembers",
      "List this project's memories, pinned first and then most recently changed. Optionally filter by kind, by pinned, or by text they contain.",
      objectSchema(
        {
          kind: KIND_SCHEMA,
          pinned: { type: "boolean", description: "Only pinned memories." },
          search: SEARCH_SCHEMA,
          limit: LIMIT_SCHEMA,
        },
        [],
      ),
      READ_BEHAVIOR,
      (input, context) =>
        read(context, (connection) => {
          only(input, ["kind", "pinned", "search", "limit"]);
          const kind = kindOf(input);
          const pinnedOnly = optionalBoolean(input, "pinned");
          const search = optionalString(input, "search");
          const limit = optionalInteger(input, "limit");
          return {
            memories: json(
              listMemories(connection, projectId, {
                ...(kind === undefined ? {} : { kind }),
                ...(pinnedOnly === true ? { pinnedOnly: true } : {}),
                ...(search === undefined ? {} : { search }),
                ...(limit === undefined ? {} : { limit }),
              }),
            ),
          };
        }),
    ),
    actionTool(
      MEMORY_ACTION_TOOL_IDS.remember,
      "Remember something",
      "Write down something about this project worth keeping beyond this conversation: a fact, a preference, a decision, or a note. Keep it short; conversations already hold the transcript.",
      objectSchema(
        { title: TITLE_SCHEMA, body: BODY_SCHEMA, kind: KIND_SCHEMA, pinned: PINNED_SCHEMA },
        ["title", "body"],
      ),
      WRITE_BEHAVIOR,
      (input, context) =>
        write(MEMORY_ACTION_TOOL_IDS.remember, input, context, (connection) => {
          only(input, ["title", "body", "kind", "pinned"]);
          const title = requiredString(input, "title");
          const body = requiredString(input, "body");
          const kind = kindOf(input);
          const pinned = optionalBoolean(input, "pinned");
          const memory = createMemory(connection, {
            memoryId: createId(),
            projectId,
            title,
            body,
            ...(kind === undefined ? {} : { kind }),
            ...(pinned === undefined ? {} : { pinned }),
            source: "agent",
            sourceRunId: runId,
            nowMs: now(),
          });
          return { memory: json(memory) };
        }),
    ),
    actionTool(
      MEMORY_ACTION_TOOL_IDS.updateMemory,
      "Change a memory",
      "Correct a memory of this project, change its kind, or pin and unpin it. A memory cannot be forgotten here; only a person can do that.",
      objectSchema(
        {
          memoryId: SORTABLE_ID_SCHEMA,
          title: TITLE_SCHEMA,
          body: BODY_SCHEMA,
          kind: KIND_SCHEMA,
          pinned: PINNED_SCHEMA,
        },
        ["memoryId"],
      ),
      WRITE_BEHAVIOR,
      (input, context) =>
        write(MEMORY_ACTION_TOOL_IDS.updateMemory, input, context, (connection) => {
          only(input, ["memoryId", "title", "body", "kind", "pinned"]);
          const memory = memoryInProject(connection, requiredString(input, "memoryId"));
          const title = optionalString(input, "title");
          const body = optionalString(input, "body");
          const kind = kindOf(input);
          const pinned = optionalBoolean(input, "pinned");
          if (
            title === undefined &&
            body === undefined &&
            kind === undefined &&
            pinned === undefined
          ) {
            throw invalidInput("Say what to change about this memory.", "memoryId");
          }
          const updated = updateMemory(connection, memory.memoryId, {
            ...(title === undefined ? {} : { title }),
            ...(body === undefined ? {} : { body }),
            ...(kind === undefined ? {} : { kind }),
            ...(pinned === undefined ? {} : { pinned }),
            nowMs: now(),
          });
          return { memory: json(updated) };
        }),
    ),
  ]);
}

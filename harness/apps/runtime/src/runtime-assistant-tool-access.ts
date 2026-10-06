import type { DatabaseSync } from "node:sqlite";
import type { SqliteMigration } from "@zet-harness/db";
import { createSortableId } from "@zet-harness/db/sortable-id";
import type { AdapterInvocationContext } from "@zet-harness/plugin-api";
import {
  AssistantAccessDenied,
  assertAssistantBinding,
  assertAssistantAccess,
  assistantId,
  type AssistantBinding,
} from "./runtime-assistant-access.js";
import {
  normalizeNativeChatToolScopes,
  readNativeChatToolScopes,
  saveNativeChatToolScopes,
  type NativeChatToolScopes,
} from "./runtime-coding-plugin-scopes.js";
export const DURABLE_ASSISTANT_TOOL_ACCESS_MIGRATION: SqliteMigration = Object.freeze({
  version: 27,
  name: "durable-assistant-tool-access",
  sql: `
CREATE TABLE assistant_tool_authorities(assistant_id TEXT NOT NULL REFERENCES assistant_roots(assistant_id),actor_chat_id TEXT NOT NULL,scopes_json TEXT NOT NULL CHECK(json_valid(scopes_json)),PRIMARY KEY(assistant_id,actor_chat_id),FOREIGN KEY(assistant_id,actor_chat_id) REFERENCES assistant_actors(assistant_id,chat_id)) STRICT;
CREATE TABLE assistant_tool_assignments(assistant_id TEXT NOT NULL REFERENCES assistant_roots(assistant_id),child_chat_id TEXT NOT NULL,authority_actor_chat_id TEXT NOT NULL,source TEXT NOT NULL CHECK(source IN ('user','parent')),PRIMARY KEY(assistant_id,child_chat_id),FOREIGN KEY(assistant_id,child_chat_id) REFERENCES assistant_actors(assistant_id,chat_id)) STRICT;
CREATE TABLE assistant_tool_requests(request_id TEXT PRIMARY KEY,assistant_id TEXT NOT NULL REFERENCES assistant_roots(assistant_id),child_chat_id TEXT NOT NULL,parent_chat_id TEXT NOT NULL,epoch INTEGER NOT NULL CHECK(epoch>=0),scopes_json TEXT NOT NULL CHECK(json_valid(scopes_json)),status TEXT NOT NULL CHECK(status IN ('pending','granted','denied')),created_at_ms INTEGER NOT NULL CHECK(created_at_ms>=0),FOREIGN KEY(assistant_id,child_chat_id) REFERENCES assistant_actors(assistant_id,chat_id),FOREIGN KEY(assistant_id,parent_chat_id) REFERENCES assistant_actors(assistant_id,chat_id)) STRICT;
CREATE INDEX assistant_tool_requests_queue ON assistant_tool_requests(assistant_id,parent_chat_id,status,created_at_ms);
`,
});
export const PARENT_DELEGABLE_NATIVE_TOOL_IDS: readonly string[] = Object.freeze([
  "harness.assistant.list",
  "harness.assistant.read",
  "harness.assistant.status",
  "harness.assistant.create",
  "harness.assistant.delegate",
  "harness.assistant.control",
  "harness.assistant.tools_request",
  "harness.assistant.tools_requests",
  "harness.assistant.tools_decide",
  "harness.fs.read",
  "harness.fs.list",
  "harness.fs.write",
  "harness.fs.apply_patch",
  "harness.fs.mkdir",
  "harness.fs.rename",
  "harness.fs.delete",
  "harness.shell.run",
  "harness.git.status",
  "harness.git.diff",
  "harness.git.log",
  "harness.git.add",
  "harness.git.commit",
  "harness.git.worktree.create",
  "harness.git.worktree.list",
  "harness.git.worktree.remove",
]);
export interface FiniteAssistantToolScopes {
  readonly model: string[];
  readonly tools: string[];
}
export interface AssistantToolAccessHost {
  toolCatalog?(): readonly string[];
  /** Trusted daemon proof of THIS parent invocation's frozen user-authorized tool policy. */
  parentToolAuthority?(
    binding: AssistantBinding,
    context: AdapterInvocationContext,
  ): NativeChatToolScopes | undefined;
}
export function createAssistantToolAccess(options: {
  db: DatabaseSync;
  userAuthority: object;
  host: AssistantToolAccessHost;
  binding(id: string, actor?: string): AssistantBinding;
  mutate(
    authority: object,
    id: string,
    action: string,
    details: unknown,
    run: () => void,
  ): AssistantBinding;
}) {
  const { db } = options;
  const transaction = <T>(run: () => T): T => {
    db.exec("BEGIN IMMEDIATE");
    try {
      const result = run();
      db.exec("COMMIT");
      return result;
    } catch (error) {
      db.exec("ROLLBACK");
      throw error;
    }
  };
  const catalog = () =>
    Object.freeze([...new Set(options.host.toolCatalog?.() ?? [])].slice(0, 200));
  const finite = (input: unknown): FiniteAssistantToolScopes => {
    const scopes = normalizeNativeChatToolScopes(input);
    if (scopes.model === null || scopes.tools === null) throw new AssistantAccessDenied();
    const known = new Set(catalog());
    if ([...scopes.model, ...scopes.tools].some((id) => !known.has(id)))
      throw new AssistantAccessDenied();
    return structuredClone(scopes) as FiniteAssistantToolScopes;
  };
  const parent = (b: AssistantBinding, child: string) => {
    assertAssistantBinding(db, b);
    assistantId(child);
    const row = db
      .prepare("SELECT parent_chat_id FROM assistant_actors WHERE assistant_id=? AND chat_id=?")
      .get(b.assistantId, child);
    if (!row || row.parent_chat_id !== b.actorChatId) throw new AssistantAccessDenied();
    assertAssistantAccess(db, b, child, "read");
    assertAssistantAccess(db, b, child, "control");
  };
  const ceiling = (b: AssistantBinding): FiniteAssistantToolScopes | null => {
    const row = db
      .prepare(
        "SELECT scopes_json FROM assistant_tool_authorities WHERE assistant_id=? AND actor_chat_id=?",
      )
      .get(b.assistantId, b.actorChatId);
    return row ? finite(JSON.parse(String(row.scopes_json))) : null;
  };
  const subset = (scopes: FiniteAssistantToolScopes, allowed: NativeChatToolScopes) =>
    scopes.model.every((id) => allowed.model === null || allowed.model.includes(id)) &&
    scopes.tools.every((id) => allowed.tools === null || allowed.tools.includes(id));
  const requestRow = (id: string) => {
    assistantId(id);
    const row = db.prepare("SELECT * FROM assistant_tool_requests WHERE request_id=?").get(id);
    if (!row) throw new AssistantAccessDenied();
    return row;
  };
  const decode = (row: Record<string, unknown>, epoch: number) => ({
    id: String(row.request_id),
    childChatId: String(row.child_chat_id),
    parentChatId: String(row.parent_chat_id),
    epoch: Number(row.epoch),
    scopes: finite(JSON.parse(String(row.scopes_json))),
    status: row.status === "pending" && Number(row.epoch) !== epoch ? "stale" : String(row.status),
  });
  const safe = (scopes: FiniteAssistantToolScopes) =>
    [...scopes.model, ...scopes.tools].every((id) => PARENT_DELEGABLE_NATIVE_TOOL_IDS.includes(id));
  const requiresUser = (b: AssistantBinding, scopes: FiniteAssistantToolScopes) => {
    const bound = ceiling(b);
    return !safe(scopes) || !bound || !subset(scopes, bound);
  };
  const user = (authority: object) => {
    if (authority !== options.userAuthority) throw new AssistantAccessDenied();
  };
  const assign = (
    id: string,
    child: string,
    scopes: FiniteAssistantToolScopes,
    action: string,
    requestId?: string,
    expectedBinding: AssistantBinding = options.binding(id),
  ) =>
    options.mutate(
      options.userAuthority,
      id,
      action,
      { childChatId: child, scopes, requestId: requestId ?? null },
      () => {
        assertAssistantBinding(db, expectedBinding);
        if (action === "child-tools-parent") parent(expectedBinding, child);
        if (requestId) {
          const request = requestRow(requestId);
          if (
            request.assistant_id !== id ||
            request.child_chat_id !== child ||
            Number(request.epoch) !== expectedBinding.epoch ||
            request.status !== "pending" ||
            (action === "child-tools-parent" &&
              request.parent_chat_id !== expectedBinding.actorChatId)
          )
            throw new AssistantAccessDenied();
        }
        const b = options.binding(id);
        if (child === id) throw new AssistantAccessDenied();
        const row = db
          .prepare("SELECT parent_chat_id FROM assistant_actors WHERE assistant_id=? AND chat_id=?")
          .get(id, child);
        if (!row || typeof row.parent_chat_id !== "string") throw new AssistantAccessDenied();
        saveNativeChatToolScopes(db, child, scopes, Date.now());
        db.prepare(
          "INSERT INTO assistant_tool_assignments VALUES(?,?,?,?) ON CONFLICT(assistant_id,child_chat_id) DO UPDATE SET authority_actor_chat_id=excluded.authority_actor_chat_id,source=excluded.source",
        ).run(
          id,
          child,
          String(row.parent_chat_id),
          action === "child-tools-parent" ? "parent" : "user",
        );
        if (requestId)
          db.prepare(
            "UPDATE assistant_tool_requests SET status='granted' WHERE request_id=? AND status='pending'",
          ).run(requestId);
        assertAssistantBinding(db, b);
      },
    );
  return Object.freeze({
    toolAccessSnapshot(b: AssistantBinding) {
      assertAssistantBinding(db, b);
      const rows = db
        .prepare(
          "SELECT chat_id,parent_chat_id FROM assistant_actors WHERE assistant_id=? ORDER BY chat_id LIMIT 200",
        )
        .all(b.assistantId);
      return {
        epoch: b.epoch,
        audit: db
          .prepare(
            "SELECT sequence,epoch,action,details_json,created_at_ms FROM assistant_access_audit WHERE assistant_id=? AND (action LIKE 'tools-%' OR action LIKE 'child-tools-%') ORDER BY sequence DESC LIMIT 200",
          )
          .all(b.assistantId)
          .map((row) => ({
            sequence: Number(row.sequence),
            epoch: Number(row.epoch),
            action: String(row.action),
            details: JSON.parse(String(row.details_json)) as unknown,
            occurredAtMs: Number(row.created_at_ms),
          })),
        catalog: catalog(),
        actors: rows.map((row) => ({
          chatId: String(row.chat_id),
          parentChatId: row.parent_chat_id === null ? null : String(row.parent_chat_id),
          scopes: readNativeChatToolScopes(db, String(row.chat_id)),
          delegationCeiling: ceiling({ ...b, actorChatId: String(row.chat_id) }),
        })),
        requests: db
          .prepare(
            "SELECT * FROM assistant_tool_requests WHERE assistant_id=? ORDER BY created_at_ms DESC,request_id DESC LIMIT 200",
          )
          .all(b.assistantId)
          .map((row) => {
            const value = decode(row, b.epoch);
            return {
              ...value,
              requiresUser:
                value.status === "stale" ||
                requiresUser({ ...b, actorChatId: value.parentChatId }, value.scopes),
            };
          }),
      };
    },
    setToolAuthority(authority: object, id: string, actor: string, input: unknown) {
      user(authority);
      const scopes = finite(input);
      if (!safe(scopes)) throw new AssistantAccessDenied();
      const expected = options.binding(id, actor);
      return options.mutate(
        authority,
        id,
        "tools-authority",
        { actorChatId: actor, scopes },
        () => {
          assertAssistantBinding(db, expected);
          db.prepare(
            "INSERT INTO assistant_tool_authorities VALUES(?,?,?) ON CONFLICT(assistant_id,actor_chat_id) DO UPDATE SET scopes_json=excluded.scopes_json",
          ).run(id, actor, JSON.stringify(scopes));
          for (const row of db
            .prepare(
              "SELECT child_chat_id FROM assistant_tool_assignments WHERE assistant_id=? AND authority_actor_chat_id=? AND source='parent'",
            )
            .all(id, actor)) {
            const current = readNativeChatToolScopes(db, String(row.child_chat_id));
            saveNativeChatToolScopes(
              db,
              String(row.child_chat_id),
              {
                model: scopes.model.filter(
                  (tool) => current.model === null || current.model.includes(tool),
                ),
                tools: scopes.tools.filter(
                  (tool) => current.tools === null || current.tools.includes(tool),
                ),
              },
              Date.now(),
            );
          }
        },
      );
    },
    assignChildTools(authority: object, id: string, child: string, input: unknown) {
      user(authority);
      return assign(id, child, finite(input), "child-tools-user");
    },
    requestTools(b: AssistantBinding, input: unknown, signal: AbortSignal) {
      return transaction(() => {
        signal.throwIfAborted();
        assertAssistantBinding(db, b);
        const row = db
          .prepare("SELECT parent_chat_id FROM assistant_actors WHERE assistant_id=? AND chat_id=?")
          .get(b.assistantId, b.actorChatId);
        if (!row || typeof row.parent_chat_id !== "string") throw new AssistantAccessDenied();
        const p = options.binding(b.assistantId, row.parent_chat_id);
        parent(p, b.actorChatId);
        const scopes = finite(input);
        if (
          Number(
            db
              .prepare(
                "SELECT count(*) AS n FROM assistant_tool_requests WHERE assistant_id=? AND epoch=? AND status='pending'",
              )
              .get(b.assistantId, b.epoch)?.n,
          ) >= 100 ||
          db
            .prepare(
              "SELECT 1 FROM assistant_tool_requests WHERE assistant_id=? AND child_chat_id=? AND epoch=? AND status='pending'",
            )
            .get(b.assistantId, b.actorChatId, b.epoch)
        )
          throw new AssistantAccessDenied();
        const id = createSortableId();
        db.prepare("INSERT INTO assistant_tool_requests VALUES(?,?,?,?,?,?,'pending',?)").run(
          id,
          b.assistantId,
          b.actorChatId,
          p.actorChatId,
          b.epoch,
          JSON.stringify(scopes),
          Date.now(),
        );
        db.prepare(
          "INSERT INTO assistant_access_audit(assistant_id,epoch,action,details_json,created_at_ms) VALUES(?,?,?,?,?)",
        ).run(
          b.assistantId,
          b.epoch,
          "tools-request",
          JSON.stringify({ id, childChatId: b.actorChatId, parentChatId: p.actorChatId, scopes }),
          Date.now(),
        );
        return {
          id,
          parentChatId: p.actorChatId,
          requiresUser: requiresUser(p, scopes),
          appliesTo: "fresh-turn-after-decision",
        };
      });
    },
    pendingToolRequests(b: AssistantBinding) {
      assertAssistantBinding(db, b);
      return db
        .prepare(
          "SELECT * FROM assistant_tool_requests WHERE assistant_id=? AND parent_chat_id=? AND status='pending' AND epoch=? ORDER BY created_at_ms,request_id LIMIT 100",
        )
        .all(b.assistantId, b.actorChatId, b.epoch)
        .map((row) => {
          const value = decode(row, b.epoch);
          return { ...value, requiresUser: requiresUser(b, value.scopes) };
        });
    },
    decideTools(
      b: AssistantBinding,
      requestId: string,
      decision: "grant" | "deny",
      context: AdapterInvocationContext,
    ) {
      context.signal.throwIfAborted();
      assertAssistantBinding(db, b);
      const row = requestRow(requestId);
      if (
        row.assistant_id !== b.assistantId ||
        row.parent_chat_id !== b.actorChatId ||
        Number(row.epoch) !== b.epoch ||
        row.status !== "pending" ||
        !["grant", "deny"].includes(decision)
      )
        throw new AssistantAccessDenied();
      parent(b, String(row.child_chat_id));
      const scopes = finite(JSON.parse(String(row.scopes_json)));
      if (decision === "grant") {
        const bound = options.host.parentToolAuthority?.(b, context);
        context.signal.throwIfAborted();
        assertAssistantBinding(db, b);
        if (!bound || requiresUser(b, scopes) || !subset(scopes, bound))
          throw new AssistantAccessDenied();
        return assign(
          b.assistantId,
          String(row.child_chat_id),
          scopes,
          "child-tools-parent",
          requestId,
          b,
        );
      }
      return transaction(() => {
        context.signal.throwIfAborted();
        assertAssistantBinding(db, b);
        parent(b, String(row.child_chat_id));
        db.prepare(
          "UPDATE assistant_tool_requests SET status='denied' WHERE request_id=? AND status='pending'",
        ).run(requestId);
        db.prepare(
          "INSERT INTO assistant_access_audit(assistant_id,epoch,action,details_json,created_at_ms) VALUES(?,?,?,?,?)",
        ).run(
          b.assistantId,
          b.epoch,
          "tools-deny",
          JSON.stringify({ requestId, actorChatId: b.actorChatId }),
          Date.now(),
        );
        return b;
      });
    },
    decideToolsUser(authority: object, id: string, requestId: string, decision: "grant" | "deny") {
      user(authority);
      const b = options.binding(id),
        row = requestRow(requestId);
      if (
        row.assistant_id !== id ||
        Number(row.epoch) !== b.epoch ||
        row.status !== "pending" ||
        !["grant", "deny"].includes(decision)
      )
        throw new AssistantAccessDenied();
      if (decision === "grant")
        return assign(
          id,
          String(row.child_chat_id),
          finite(JSON.parse(String(row.scopes_json))),
          "child-tools-user",
          requestId,
        );
      return transaction(() => {
        assertAssistantBinding(db, b);
        db.prepare("UPDATE assistant_tool_requests SET status='denied' WHERE request_id=?").run(
          requestId,
        );
        db.prepare(
          "INSERT INTO assistant_access_audit(assistant_id,epoch,action,details_json,created_at_ms) VALUES(?,?,?,?,?)",
        ).run(id, b.epoch, "tools-deny-user", JSON.stringify({ requestId }), Date.now());
        return b;
      });
    },
  });
}

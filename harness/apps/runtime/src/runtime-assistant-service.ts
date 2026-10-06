import {
  createAssistantToolAccess,
  type AssistantToolAccessHost,
} from "./runtime-assistant-tool-access.js";
import type { DatabaseSync } from "node:sqlite";
import {
  AssistantAccessDenied,
  assistantEpoch,
  assistantGrants,
  assistantId,
  assistantPermissions,
  assertAssistantAccess,
  assertAssistantBinding,
  type AssistantBinding,
  type AssistantGrant,
  type AssistantPermission,
} from "./runtime-assistant-access.js";
export interface RuntimeAssistantHost extends AssistantToolAccessHost {
  read(chatId: string, signal: AbortSignal, binding: AssistantBinding): Promise<unknown>;
  status(chatId: string, signal: AbortSignal, binding: AssistantBinding): Promise<unknown>;
  create(parentChatId: string, signal: AbortSignal, binding: AssistantBinding): Promise<string>;
  delegate(
    chatId: string,
    input: Readonly<Record<string, unknown>>,
    signal: AbortSignal,
    binding: AssistantBinding,
  ): Promise<unknown>;
  control(
    chatId: string,
    input: Readonly<Record<string, unknown>>,
    signal: AbortSignal,
    binding: AssistantBinding,
  ): Promise<unknown>;
  revoke(assistantId: string, epoch: number): void;
  /** Synchronous DB-only context floor writes; called within the mutation transaction. */
  invalidateMemory(assistantId: string, epoch: number): void;
}
/** User authority is an object identity kept exclusively by trusted HTTP/UI host code. Never expose it to models. */
export function createRuntimeAssistantService(
  db: DatabaseSync,
  host: RuntimeAssistantHost,
  userAuthority: object,
) {
  const user = (authority: object) => {
    if (authority !== userAuthority) throw new AssistantAccessDenied();
  };
  const transaction = (run: () => void) => {
    db.exec("BEGIN IMMEDIATE");
    try {
      run();
      db.exec("COMMIT");
    } catch (error) {
      db.exec("ROLLBACK");
      throw error;
    }
  };
  const audit = (id: string, epoch: number, action: string, details: unknown) =>
    db
      .prepare(
        "INSERT INTO assistant_access_audit(assistant_id,epoch,action,details_json,created_at_ms) VALUES(?,?,?,?,?)",
      )
      .run(id, epoch, action, JSON.stringify(details), Date.now());
  const binding = (id: string, actor = id): AssistantBinding => {
    const b = Object.freeze({ assistantId: id, actorChatId: actor, epoch: assistantEpoch(db, id) });
    assertAssistantBinding(db, b);
    return b;
  };
  const mutate = (
    authority: object,
    id: string,
    action: string,
    details: unknown,
    run: () => void,
  ) => {
    user(authority);
    assistantId(id);
    let epoch = 0;
    transaction(() => {
      epoch = assistantEpoch(db, id) + 1;
      run();
      db.prepare("UPDATE assistant_roots SET epoch=? WHERE assistant_id=?").run(epoch, id);
      audit(id, epoch, action, details);
      const invalidated: unknown = host.invalidateMemory(id, epoch);
      if (invalidated !== undefined)
        throw new TypeError("Assistant context invalidation must be synchronous.");
    });
    host.revoke(id, epoch);
    return binding(id);
  };
  const checked = async (
    b: AssistantBinding,
    target: string,
    p: AssistantPermission,
    signal: AbortSignal,
    run: () => Promise<unknown>,
  ) => {
    signal.throwIfAborted();
    assertAssistantAccess(db, b, target, p);
    if (p === "control") assertAssistantAccess(db, b, target, "read");
    audit(b.assistantId, b.epoch, "dispatch", {
      actorChatId: b.actorChatId,
      target,
      permission: p,
    });
    const result = await run();
    signal.throwIfAborted();
    assertAssistantAccess(db, b, target, p);
    if (p === "control") assertAssistantAccess(db, b, target, "read");
    return result;
  };
  return Object.freeze({
    ...createAssistantToolAccess({ db, userAuthority, host, binding, mutate }),
    createRoot(authority: object, id: string) {
      user(authority);
      assistantId(id);
      transaction(() => {
        if (
          db.prepare("SELECT 1 FROM assistant_actors WHERE chat_id=?").get(id) ||
          db.prepare("SELECT 1 FROM assistant_edges WHERE chat_id=?").get(id)
        )
          throw new AssistantAccessDenied();
        db.prepare("INSERT INTO assistant_roots VALUES(?,0)").run(id);
        db.prepare("INSERT INTO assistant_actors VALUES(?,?,NULL)").run(id, id);
        db.prepare("INSERT INTO assistant_edges VALUES(?,?,?,?)").run(
          id,
          id,
          id,
          JSON.stringify(["read", "control"]),
        );
        audit(id, 0, "create-root", {});
      });
      return binding(id);
    },
    issueBinding: binding,
    bindRun(
      runId: string,
      b: AssistantBinding,
      target: string,
      origin: "user" | "delegated" = "user",
    ) {
      assistantId(runId);
      if (origin !== "user" && origin !== "delegated") throw new AssistantAccessDenied();
      assertAssistantAccess(db, b, target, "read");
      assertAssistantAccess(db, b, target, "control");
      const effective = origin === "delegated" ? binding(b.assistantId, target) : b;
      if (origin === "delegated" && target === b.assistantId) throw new AssistantAccessDenied();
      assertAssistantAccess(db, effective, target, "read");
      assertAssistantAccess(db, effective, target, "control");
      db.prepare("INSERT INTO assistant_runs VALUES(?,?,?,?,?,?)").run(
        runId,
        effective.assistantId,
        effective.actorChatId,
        target,
        b.epoch,
        origin,
      );
    },
    bindingForRun(runId: string) {
      assistantId(runId);
      const row = db.prepare("SELECT * FROM assistant_runs WHERE run_id=?").get(runId);
      if (
        !row ||
        (row.origin === "delegated" &&
          (row.actor_chat_id !== row.target_chat_id || row.target_chat_id === row.assistant_id))
      )
        throw new AssistantAccessDenied();
      const b = Object.freeze({
        assistantId: String(row.assistant_id),
        actorChatId: String(row.actor_chat_id),
        epoch: Number(row.epoch),
      });
      assertAssistantAccess(db, b, String(row.target_chat_id), "read");
      assertAssistantAccess(db, b, String(row.target_chat_id), "control");
      return Object.freeze({
        binding: b,
        targetChatId: String(row.target_chat_id),
        origin: String(row.origin) as "user" | "delegated",
      });
    },
    assertRunAccess(runId: string) {
      return this.bindingForRun(runId);
    },
    setContextFloor(id: string, actor: string, epoch: number, boundaryMessageId: string | null) {
      assistantId(actor);
      if (
        assistantEpoch(db, id) !== epoch ||
        !db
          .prepare(
            "SELECT 1 FROM assistant_actors WHERE assistant_id=? AND chat_id=? UNION SELECT 1 FROM assistant_runs WHERE assistant_id=? AND target_chat_id=?",
          )
          .get(id, actor, id, actor)
      )
        throw new AssistantAccessDenied();
      if (boundaryMessageId !== null) assistantId(boundaryMessageId);
      db.prepare(
        "INSERT INTO assistant_context_floors VALUES(?,?,?,?) ON CONFLICT(assistant_id,actor_chat_id,epoch) DO UPDATE SET boundary_message_id=excluded.boundary_message_id",
      ).run(id, actor, epoch, boundaryMessageId);
    },
    contextFloor(b: AssistantBinding, targetChatId = b.actorChatId): string | null {
      assertAssistantAccess(db, b, targetChatId, "read");
      const row = db
        .prepare(
          "SELECT boundary_message_id FROM assistant_context_floors WHERE assistant_id=? AND actor_chat_id=? AND epoch=?",
        )
        .get(b.assistantId, targetChatId, b.epoch);
      return row?.boundary_message_id === undefined || row.boundary_message_id === null
        ? null
        : String(row.boundary_message_id);
    },

    revocationChatIds(id: string): readonly string[] {
      assistantEpoch(db, id);
      return Object.freeze(
        db
          .prepare(
            "SELECT chat_id FROM assistant_actors WHERE assistant_id=? UNION SELECT target_chat_id AS chat_id FROM assistant_runs WHERE assistant_id=? ORDER BY chat_id",
          )
          .all(id, id)
          .map((row) => String(row.chat_id)),
      );
    },
    actorChatIds(id: string): readonly string[] {
      assistantEpoch(db, id);
      return Object.freeze(
        db
          .prepare("SELECT chat_id FROM assistant_actors WHERE assistant_id=? ORDER BY chat_id")
          .all(id)
          .map((row) => String(row.chat_id)),
      );
    },
    snapshot(b: AssistantBinding) {
      return Object.freeze({
        binding: b,
        grants: assistantGrants(db, b),
        notice:
          "Revocation blocks future retrieval and invalidates linked context; already observed outputs cannot be erased.",
      });
    },
    connect(
      authority: object,
      id: string,
      target: string,
      permissions: readonly AssistantPermission[],
    ) {
      assistantId(target);
      if (id === target) throw new AssistantAccessDenied();
      const safe = assistantPermissions(permissions);
      return mutate(authority, id, "connect", { target, permissions: safe }, () => {
        if (
          db.prepare("SELECT 1 FROM assistant_roots WHERE assistant_id=?").get(target) ||
          db
            .prepare("SELECT 1 FROM assistant_actors WHERE chat_id=? AND assistant_id<>?")
            .get(target, id)
        )
          throw new AssistantAccessDenied();
        db.prepare(
          "INSERT INTO assistant_edges VALUES(?,?,?,?) ON CONFLICT(assistant_id,actor_chat_id,chat_id) DO UPDATE SET permissions_json=excluded.permissions_json",
        ).run(id, id, target, JSON.stringify(safe));
        if (
          db
            .prepare("SELECT 1 FROM assistant_actors WHERE assistant_id=? AND chat_id=?")
            .get(id, target)
        )
          db.prepare(
            "INSERT INTO assistant_edges VALUES(?,?,?,?) ON CONFLICT(assistant_id,actor_chat_id,chat_id) DO UPDATE SET permissions_json=excluded.permissions_json",
          ).run(id, target, target, JSON.stringify(safe));

        for (const row of db
          .prepare(
            "SELECT actor_chat_id,permissions_json FROM assistant_edges WHERE assistant_id=? AND chat_id=? AND actor_chat_id<>?",
          )
          .all(id, target, id)) {
          const reduced = assistantPermissions(JSON.parse(String(row.permissions_json))).filter(
            (permission) => safe.includes(permission),
          );
          if (reduced.length)
            db.prepare(
              "UPDATE assistant_edges SET permissions_json=? WHERE assistant_id=? AND actor_chat_id=? AND chat_id=?",
            ).run(JSON.stringify(reduced), id, String(row.actor_chat_id), target);
          else
            db.prepare(
              "DELETE FROM assistant_edges WHERE assistant_id=? AND actor_chat_id=? AND chat_id=?",
            ).run(id, String(row.actor_chat_id), target);
        }
      });
    },
    disconnect(authority: object, id: string, target: string) {
      assistantId(target);
      if (id === target) throw new AssistantAccessDenied();
      return mutate(authority, id, "disconnect", { target }, () => {
        db.prepare(
          "WITH RECURSIVE descendants(chat_id) AS (SELECT chat_id FROM assistant_actors WHERE assistant_id=? AND chat_id=? UNION SELECT a.chat_id FROM assistant_actors a JOIN descendants d ON a.parent_chat_id=d.chat_id WHERE a.assistant_id=?) DELETE FROM assistant_edges WHERE assistant_id=? AND actor_chat_id IN (SELECT chat_id FROM descendants)",
        ).run(id, target, id, id);

        db.prepare("DELETE FROM assistant_edges WHERE assistant_id=? AND chat_id=?").run(
          id,
          target,
        );
      });
    },
    read: (b: AssistantBinding, target: string, signal: AbortSignal) =>
      checked(b, target, "read", signal, () => host.read(target, signal, b)),
    status: (b: AssistantBinding, target: string, signal: AbortSignal) =>
      checked(b, target, "read", signal, () => host.status(target, signal, b)),
    delegate: (
      b: AssistantBinding,
      target: string,
      input: Readonly<Record<string, unknown>>,
      signal: AbortSignal,
    ) => checked(b, target, "control", signal, () => host.delegate(target, input, signal, b)),
    control: (
      b: AssistantBinding,
      target: string,
      input: Readonly<Record<string, unknown>>,
      signal: AbortSignal,
    ) => checked(b, target, "control", signal, () => host.control(target, input, signal, b)),
    async createChild(b: AssistantBinding, grants: readonly AssistantGrant[], signal: AbortSignal) {
      assertAssistantBinding(db, b);
      signal.throwIfAborted();
      if (
        grants.length > 200 ||
        Number(
          db
            .prepare("SELECT count(*) AS n FROM assistant_actors WHERE assistant_id=?")
            .get(b.assistantId)?.n,
        ) >= 200
      )
        throw new AssistantAccessDenied();
      for (const grant of grants) {
        if (
          !grant ||
          typeof grant !== "object" ||
          Array.isArray(grant) ||
          Reflect.ownKeys(grant).length !== 2 ||
          !Object.hasOwn(grant, "chatId") ||
          !Object.hasOwn(grant, "permissions")
        )
          throw new AssistantAccessDenied();
      }
      const copied = grants.map((g) => ({
        chatId: g.chatId,
        permissions: assistantPermissions(g.permissions),
      }));
      if (new Set(copied.map((g) => g.chatId)).size !== copied.length)
        throw new AssistantAccessDenied();
      const ancestors = new Set<string>();
      let ancestor = b.actorChatId;
      while (true) {
        if (ancestors.has(ancestor) || ancestors.size >= 64) throw new AssistantAccessDenied();
        ancestors.add(ancestor);
        if (ancestor === b.assistantId) break;
        const row = db
          .prepare("SELECT parent_chat_id FROM assistant_actors WHERE assistant_id=? AND chat_id=?")
          .get(b.assistantId, ancestor);
        if (!row || typeof row.parent_chat_id !== "string") throw new AssistantAccessDenied();
        ancestor = row.parent_chat_id;
      }
      for (const g of copied) {
        if (ancestors.has(g.chatId)) throw new AssistantAccessDenied();
        for (const p of g.permissions) assertAssistantAccess(db, b, g.chatId, p);
      }

      const child = await host.create(b.actorChatId, signal, b);
      signal.throwIfAborted();
      assertAssistantBinding(db, b);
      assistantId(child);
      if (
        child === b.assistantId ||
        child === b.actorChatId ||
        db.prepare("SELECT 1 FROM assistant_actors WHERE chat_id=?").get(child) ||
        db.prepare("SELECT 1 FROM assistant_edges WHERE chat_id=?").get(child)
      )
        throw new AssistantAccessDenied();
      transaction(() => {
        assertAssistantBinding(db, b);
        db.prepare("INSERT INTO assistant_actors VALUES(?,?,?)").run(
          b.assistantId,
          child,
          b.actorChatId,
        );
        db.prepare("INSERT INTO assistant_edges VALUES(?,?,?,?)").run(
          b.assistantId,
          child,
          child,
          JSON.stringify(["read", "control"]),
        );
        db.prepare("INSERT INTO assistant_edges VALUES(?,?,?,?)").run(
          b.assistantId,
          b.actorChatId,
          child,
          JSON.stringify(["read", "control"]),
        );
        if (b.actorChatId !== b.assistantId)
          db.prepare("INSERT INTO assistant_edges VALUES(?,?,?,?)").run(
            b.assistantId,
            b.assistantId,
            child,
            JSON.stringify(["read", "control"]),
          );
        for (const g of copied) {
          for (const p of g.permissions) assertAssistantAccess(db, b, g.chatId, p);
          db.prepare("INSERT INTO assistant_edges VALUES(?,?,?,?)").run(
            b.assistantId,
            child,
            g.chatId,
            JSON.stringify(g.permissions),
          );
        }
        audit(b.assistantId, b.epoch, "create-child", {
          child,
          parent: b.actorChatId,
          grants: copied,
        });
      });
      return binding(b.assistantId, child);
    },
  });
}
export type RuntimeAssistantService = ReturnType<typeof createRuntimeAssistantService>;

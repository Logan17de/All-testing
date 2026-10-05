import { resolve } from "node:path";
import type { SqliteDatabase } from "@zet-harness/db";
import { createSortableId } from "@zet-harness/db/sortable-id";
import { createProject } from "@zet-harness/db/durable-project-records";
import { createConversation, readConversation } from "@zet-harness/db/durable-conversation-records";
import type { RuntimeCodingService } from "./runtime-coding-service.js";
import type { RuntimeAssistantService } from "./runtime-assistant-service.js";
import { assistantPermissions, type AssistantGrant } from "./runtime-assistant-access.js";

/** Local user control surface. Models receive only the separately scoped assistant tool adapters. */
export class RuntimeAssistantController {
  constructor(
    readonly services: {
      database: SqliteDatabase;
      coding: RuntimeCodingService;
      assistant(): RuntimeAssistantService;
      userAuthority: object;
      workspace(): string;
    },
  ) {}
  async snapshot() {
    const before = this.services.coding.snapshot().scopeGeneration;
    const result = (await this.services.coding.action("session/list")) as {
      data: { id: string; preview: string; status: string }[];
    };
    if (before !== this.services.coding.snapshot().scopeGeneration)
      throw new Error("Workspace changed.");
    const ids = new Set(result.data.map((chat) => chat.id));
    const roots = this.services.database
      .connection()
      .prepare("SELECT assistant_id,epoch FROM assistant_roots ORDER BY assistant_id LIMIT 200")
      .all();
    return {
      scopeGeneration: before,
      chats: result.data.map(({ id, preview, status }) => ({ id, title: preview, status })),
      assistants: roots
        .filter((row) => ids.has(String(row.assistant_id)))
        .map((row) => ({
          assistantId: String(row.assistant_id),
          chatId: String(row.assistant_id),
          epoch: Number(row.epoch),
          title:
            result.data.find((chat) => chat.id === row.assistant_id)?.preview ??
            "Personal assistant",
        })),
    };
  }
  async action(action: string, params: Record<string, unknown> = {}) {
    const fields: Record<string, readonly string[]> = {
      create: ["chatId"],
      read: ["assistantId"],
      connect: ["assistantId", "chatId", "permissions", "confirm"],
      disconnect: ["assistantId", "chatId"],
      "child/create": ["assistantId", "title", "grants"],
    };
    if (!fields[action] || Object.keys(params).some((key) => !fields[action]!.includes(key)))
      throw new Error("Invalid assistant action.");
    const generation = this.services.coding.snapshot().scopeGeneration;
    const metadata = await this.snapshot();
    const chat = (id: unknown) => {
      if (typeof id !== "string" || !metadata.chats.some((chat) => chat.id === id))
        throw new Error("Chat is outside this workspace.");
      return id;
    };
    const assistant = this.services.assistant();
    const current = () => {
      if (generation !== this.services.coding.snapshot().scopeGeneration)
        throw new Error("Workspace changed.");
    };
    if (action === "create") {
      let id: string;
      if (params.chatId !== undefined) id = chat(params.chatId);
      else {
        const root = resolve(this.services.workspace());
        id = await this.services.database.commit((db) => {
          const nowMs = Date.now(),
            projectId = createSortableId(),
            conversationId = createSortableId();
          createProject(db, { projectId, name: "Personal assistant", workspacePath: root, nowMs });
          createConversation(db, { conversationId, projectId, title: "Personal assistant", nowMs });
          return conversationId;
        });
      }
      current();
      return assistant.snapshot(assistant.createRoot(this.services.userAuthority, id));
    }
    const id = chat(params.assistantId);
    if (!metadata.assistants.some((root) => root.assistantId === id))
      throw new Error("Unknown assistant in this workspace.");
    current();
    if (action === "read") return assistant.snapshot(assistant.issueBinding(id));
    if (action === "connect") {
      if (params.confirm !== true)
        throw new Error("Explicit user confirmation is required for a chat connection.");
      const target = chat(params.chatId),
        permissions = assistantPermissions(params.permissions);
      return assistant.snapshot(
        assistant.connect(this.services.userAuthority, id, target, permissions),
      );
    }
    if (action === "disconnect")
      return assistant.snapshot(
        assistant.disconnect(this.services.userAuthority, id, chat(params.chatId)),
      );
    if (!Array.isArray(params.grants) || params.grants.length > 200)
      throw new Error("Select an explicit bounded child grant subset.");
    const title = params.title;
    if (title !== undefined && (typeof title !== "string" || !title.trim() || title.length > 200))
      throw new Error("Invalid child title.");
    const childBinding = await assistant.createChild(
      assistant.issueBinding(id),
      params.grants as AssistantGrant[],
      new AbortController().signal,
    );
    const child = childBinding.actorChatId;
    current();
    if (typeof title === "string")
      await this.services.database.commit((db) => {
        if (!readConversation(db, child)) throw new Error("Child chat unavailable.");
        db.prepare("UPDATE conversations SET title=?,updated_at_ms=? WHERE conversation_id=?").run(
          title.trim(),
          Date.now(),
          child,
        );
      });
    return { chatId: child, ...assistant.snapshot(assistant.issueBinding(id)) };
  }
}

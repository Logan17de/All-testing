import type {
  CodingImageAuthority,
  RuntimeCodingImageStore,
} from "./runtime-coding-image-store.js";
import type { ModelImagePart } from "@zet-harness/plugin-api";
import { randomUUID } from "node:crypto";
import { open } from "node:fs/promises";
import { constants } from "node:fs";
import type { IncomingMessage, ServerResponse } from "node:http";
import {
  RuntimeDesktopSession,
  type DesktopAction,
  type DesktopConsentRequest,
  type DesktopDriver,
} from "./runtime-desktop-session.js";
import { RuntimeWindowsDesktopDriver } from "./runtime-windows-desktop.js";
import type { RuntimeApiSecurity } from "./runtime-api-security.js";
import { writeRuntimeJson } from "./runtime-approval-http.js";

type Pending = {
  request: DesktopConsentRequest & { id: string };
  finish: (approved: boolean) => void;
};
const object = (value: unknown): Record<string, unknown> =>
  value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
const only = (params: Record<string, unknown>, keys: string[]) => {
  if (Object.keys(params).some((key) => !keys.includes(key)))
    throw new Error("Unsupported desktop parameter.");
};
const generationOf = (params: Record<string, unknown>): number => {
  if (!Number.isSafeInteger(params.generation) || (params.generation as number) < 0)
    throw new Error("Invalid desktop generation.");
  return params.generation as number;
};

/** Exact, one-use human decisions; never a permissive generic host approval. */
export class RuntimeDesktopController {
  readonly session: RuntimeDesktopSession;
  #pending = new Map<string, Pending>();
  constructor(options: { driver?: DesktopDriver } = {}) {
    this.session = new RuntimeDesktopSession({
      ...options,
      approve: (request, signal) => this.#approve(request, signal),
    });
  }
  #approve(request: DesktopConsentRequest, signal: AbortSignal): Promise<boolean> {
    if (signal.aborted || this.#pending.size >= 10) return Promise.resolve(false);
    const id = randomUUID();
    return new Promise((resolve) => {
      let done = false;
      const finish = (approved: boolean) => {
        if (done) return;
        done = true;
        clearTimeout(timer);
        signal.removeEventListener("abort", aborted);
        this.#pending.delete(id);
        resolve(approved);
      };
      const aborted = () => finish(false);
      const timer = setTimeout(aborted, 90_000);
      timer.unref?.();
      this.#pending.set(id, { request: { ...structuredClone(request), id }, finish });
      signal.addEventListener("abort", aborted, { once: true });
      if (signal.aborted) aborted();
    });
  }
  snapshot() {
    return {
      ...this.session.status(),
      pendingConsents: [...this.#pending.values()].map((value) => structuredClone(value.request)),
    };
  }
  close(): void {
    this.session.stop();
    for (const pending of this.#pending.values()) pending.finish(false);
  }
  async action(action: string, params: Record<string, unknown>): Promise<unknown> {
    if (action === "inventory") {
      only(params, []);
      await this.session.inventory();
      return this.snapshot();
    }
    if (action === "arm") {
      only(params, ["task", "monitorId", "windowId", "confirm"]);
      if (
        params.confirm !== true ||
        typeof params.task !== "string" ||
        typeof params.monitorId !== "string" ||
        (params.windowId !== undefined && typeof params.windowId !== "string")
      )
        throw new Error("Explicit task consent required.");
      this.session.arm({
        task: params.task,
        monitorId: params.monitorId,
        ...(typeof params.windowId === "string" ? { windowId: params.windowId } : {}),
      });
      return this.snapshot();
    }
    if (action === "stop") {
      only(params, []);
      this.session.stop();
      return this.snapshot();
    }
    if (action === "capture") {
      only(params, ["generation"]);
      return this.session.capture(generationOf(params));
    }
    if (action === "act") {
      only(params, ["generation", "action"]);
      await this.session.act(
        generationOf(params),
        object(params.action) as unknown as DesktopAction,
      );
      return { requested: true };
    }
    if (action === "export")
      throw new Error("Use an active coding turn's scoped screenshot sharing tool.");
    if (action === "approval/respond") {
      only(params, ["id", "generation", "decision"]);
      if (
        typeof params.id !== "string" ||
        !["approved", "rejected"].includes(String(params.decision))
      )
        throw new Error("Invalid desktop decision.");
      const pending = this.#pending.get(params.id);
      if (
        !pending ||
        generationOf(params) !== pending.request.generation ||
        pending.request.generation !== this.session.status().generation
      )
        throw new Error("Stale desktop consent.");
      pending.finish(params.decision === "approved");
      return { responded: true };
    }
    throw new Error("Unknown desktop action.");
  }
  /** Trusted native tool bridge. HTTP cannot supply or forge turn/model/account authority. */
  async approveTurnImage(
    input: { authority: CodingImageAuthority; artifactId: string; maxUses: number },
    store: RuntimeCodingImageStore,
    signal: AbortSignal,
  ): Promise<ModelImagePart> {
    signal.throwIfAborted();
    const authority = Object.freeze({ ...input.authority });
    const current = this.session.status();
    if (
      !store.authorized(authority) ||
      current.state !== "armed" ||
      current.generation !== authority.desktopGeneration
    )
      throw new Error("Desktop turn scope expired.");
    const stopped = () => this.close();
    signal.addEventListener("abort", stopped, { once: true });
    let bytes: Buffer | undefined;
    try {
      await this.session.approveTransmission(authority.desktopGeneration, input.artifactId, true, {
        runId: authority.runId,
        sessionId: authority.sessionId,
        modelId: authority.modelId,
        accountId: authority.accountId,
        maxUses: input.maxUses,
        expiresAtMs: current.expiresAt!,
      });
      signal.throwIfAborted();
      if (!store.authorized(authority)) throw new Error("Desktop turn scope expired.");
      bytes = await this.preview(authority.desktopGeneration, input.artifactId);
      signal.throwIfAborted();
      const scope = this.session.status();
      if (
        scope.state !== "armed" ||
        scope.generation !== authority.desktopGeneration ||
        scope.expiresAt === undefined
      )
        throw new Error("Desktop turn scope expired.");
      const image = this.session.previewArtifact(authority.desktopGeneration, input.artifactId);
      if (
        bytes.length < 24 ||
        bytes.readUInt32BE(16) !== image.width ||
        bytes.readUInt32BE(20) !== image.height
      )
        throw new Error("Screenshot dimensions mismatch.");
      return store.createApprovedLease({
        authority,
        bytes,
        artifactId: input.artifactId,
        expiresAt: scope.expiresAt,
        maxUses: input.maxUses,
        approved: true,
      });
    } finally {
      bytes?.fill(0);
      signal.removeEventListener("abort", stopped);
    }
  }
  async preview(generation: number, artifactId: string): Promise<Buffer> {
    const capture = this.session.previewArtifact(generation, artifactId);
    const file = await open(capture.localPath, constants.O_RDONLY | (constants.O_NOFOLLOW || 0));
    try {
      const stat = await file.stat();
      if (!stat.isFile() || stat.nlink !== 1 || stat.size > 32 * 1024 * 1024)
        throw new Error("Invalid local preview.");
      const buffer = Buffer.alloc(32 * 1024 * 1024 + 1);
      let length = 0;
      while (length < buffer.length) {
        const read = await file.read(buffer, length, buffer.length - length, length);
        if (read.bytesRead === 0) break;
        length += read.bytesRead;
      }
      if (length > 32 * 1024 * 1024) throw new Error("Local preview exceeds limit.");
      const data = buffer.subarray(0, length);
      this.session.previewArtifact(generation, artifactId);
      if (!data.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])))
        throw new Error("Invalid local PNG preview.");
      return data;
    } finally {
      await file.close();
    }
  }
}
export function configuredDesktopController(): RuntimeDesktopController {
  return process.platform === "win32" && process.env["ZET_DESKTOP_DRIVER"] === "windows-powershell"
    ? new RuntimeDesktopController({ driver: new RuntimeWindowsDesktopDriver() })
    : new RuntimeDesktopController();
}
export function isDesktopHttpPath(path: string): boolean {
  return path === "/api/desktop" || /^\/api\/desktop\/artifacts\/[0-9a-f-]{36}$/u.test(path);
}
export function createDesktopHttpHandler(controller: RuntimeDesktopController) {
  return async (
    request: IncomingMessage,
    response: ServerResponse,
    url: URL,
    security: RuntimeApiSecurity,
  ): Promise<void> => {
    try {
      if (request.method === "GET" && url.pathname !== "/api/desktop") {
        const artifactId = url.pathname.split("/").at(-1)!;
        const generation = Number(url.searchParams.get("generation"));
        if (!Number.isSafeInteger(generation) || !url.searchParams.has("generation"))
          throw new Error();
        const png = await controller.preview(generation, artifactId);
        response.writeHead(200, {
          "content-type": "image/png",
          "cache-control": "private, no-store",
          "x-content-type-options": "nosniff",
          "cross-origin-resource-policy": "same-origin",
        });
        response.end(png);
        return;
      }
      if (request.method === "GET") {
        writeRuntimeJson(response, 200, controller.snapshot());
        return;
      }
      if (request.method !== "POST" || url.pathname !== "/api/desktop") {
        writeRuntimeJson(response, 405, { error: { code: "METHOD_NOT_ALLOWED" } });
        return;
      }
      security.checkMutation(request);
      let body = "";
      for await (const chunk of request.iterator({ destroyOnReturn: false })) {
        body += String(chunk);
        if (Buffer.byteLength(body) > 32_768) {
          request.resume();
          writeRuntimeJson(response, 413, { error: { code: "BODY_TOO_LARGE" } });
          return;
        }
      }
      const value = object(JSON.parse(body));
      if (
        typeof value.action !== "string" ||
        !value.params ||
        typeof value.params !== "object" ||
        Array.isArray(value.params)
      )
        throw new Error();
      writeRuntimeJson(response, 200, {
        result: await controller.action(value.action, object(value.params)),
      });
    } catch {
      writeRuntimeJson(response, 400, {
        error: {
          code: "DESKTOP_REQUEST_FAILED",
          reason:
            "Desktop request refused. Check session scope, explicit consent, expiry and local driver configuration.",
        },
      });
    }
  };
}

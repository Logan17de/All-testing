import { reasonOf } from "../../lib/workspace-types";
import type { WorkspaceResult } from "../../lib/workspace-client";
export interface TerminalChunk {
  sequence: number;
  stream: "stdout" | "stderr" | "terminal";
  text: string;
}
export interface TerminalSession {
  id: string;
  conversationId: string;
  cwd: string;
  identity?: string;
  shell?: string;
  status: "running" | "exited" | "closed" | "failed";
  exitCode: number | null;
  cols: number;
  rows: number;
  chunks: TerminalChunk[];
  cursor: number;
  truncated: boolean;
}
export interface TerminalSnapshot {
  capability: {
    launch: boolean;
    interactive: boolean;
    input: boolean;
    resize: boolean;
    interrupt: boolean;
    mode: "sandbox-pty" | "human-host-pty" | "process-output" | "unavailable";
    reason: string;
  };
  sessions: TerminalSession[];
  grantReview?: {
    nonce: string;
    identity: string;
    shell: string;
    cwd: string;
    conversationId: string;
    expiresAt: number;
  };
}
const record = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value);
const boundedText = (value: unknown, max: number): value is string =>
  typeof value === "string" && value.length <= max;
function validSession(value: unknown): value is TerminalSession {
  if (
    !record(value) ||
    !boundedText(value.id, 128) ||
    !value.id ||
    !boundedText(value.conversationId, 128) ||
    !value.conversationId ||
    !boundedText(value.cwd, 4096) ||
    (value.identity !== undefined && !boundedText(value.identity, 4096)) ||
    (value.shell !== undefined && !boundedText(value.shell, 4096)) ||
    typeof value.status !== "string" ||
    !["running", "exited", "closed", "failed"].includes(value.status) ||
    (value.exitCode !== null && !Number.isSafeInteger(value.exitCode)) ||
    !Number.isInteger(value.cols) ||
    Number(value.cols) < 10 ||
    Number(value.cols) > 300 ||
    !Number.isInteger(value.rows) ||
    Number(value.rows) < 2 ||
    Number(value.rows) > 120 ||
    !Number.isSafeInteger(value.cursor) ||
    Number(value.cursor) < 0 ||
    typeof value.truncated !== "boolean" ||
    !Array.isArray(value.chunks) ||
    value.chunks.length > 256
  )
    return false;
  let previous = 0;
  let size = 0;
  for (const chunk of value.chunks as unknown[]) {
    if (
      !record(chunk) ||
      !Number.isSafeInteger(chunk.sequence) ||
      Number(chunk.sequence) <= previous ||
      Number(chunk.sequence) > Number(value.cursor) ||
      (chunk.stream !== "stdout" && chunk.stream !== "stderr" && chunk.stream !== "terminal") ||
      !boundedText(chunk.text, 16384)
    )
      return false;
    previous = Number(chunk.sequence);
    size += chunk.text.length;
    if (size > 65536) return false;
  }
  return true;
}
function validSnapshot(value: unknown): value is TerminalSnapshot {
  if (
    !record(value) ||
    !record(value.capability) ||
    !Array.isArray(value.sessions) ||
    value.sessions.length > 64
  )
    return false;
  const cap = value.capability;
  if (
    !["launch", "interactive", "input", "resize", "interrupt"].every(
      (key) => typeof cap[key] === "boolean",
    ) ||
    typeof cap.mode !== "string" ||
    !["sandbox-pty", "human-host-pty", "process-output", "unavailable"].includes(cap.mode) ||
    !boundedText(cap.reason, 4096)
  )
    return false;
  if (
    cap.mode === "unavailable" &&
    [cap.launch, cap.interactive, cap.input, cap.resize, cap.interrupt].some(Boolean)
  )
    return false;
  if (
    cap.mode === "process-output" &&
    [cap.interactive, cap.input, cap.resize, cap.interrupt].some(Boolean)
  )
    return false;
  const ids = new Set<string>();
  if (value.grantReview !== undefined) {
    const review = value.grantReview;
    if (
      !record(review) ||
      !["nonce", "identity", "shell", "cwd", "conversationId"].every(
        (key) => boundedText(review[key], 4096) && Boolean(review[key]),
      ) ||
      !Number.isSafeInteger(review.expiresAt)
    )
      return false;
  }
  for (const session of value.sessions as unknown[]) {
    if (!validSession(session) || ids.has(session.id)) return false;
    ids.add(session.id);
  }
  return true;
}
export async function readTerminals(
  conversationId: string,
): Promise<WorkspaceResult<TerminalSnapshot>> {
  const result = await request(`?conversationId=${encodeURIComponent(conversationId)}`);
  if (!result.ok) return result;
  if (
    !validSnapshot(result.data) ||
    (result.data.grantReview !== undefined &&
      result.data.grantReview.conversationId !== conversationId) ||
    result.data.sessions.some((s) => s.conversationId !== conversationId)
  )
    return { ok: false, reason: "Terminal service returned an invalid session snapshot." };
  return { ok: true, data: result.data };
}
export function terminalAction(
  conversationId: string,
  action: string,
  fields: Record<string, unknown> = {},
) {
  return request("", { ...fields, conversationId, action });
}
async function request(query: string, body?: unknown): Promise<WorkspaceResult<unknown>> {
  try {
    const response = await fetch(
      `/api/editor/terminal${query}`,
      body === undefined
        ? { cache: "no-store" }
        : {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify(body),
            cache: "no-store",
          },
    );
    const data: unknown = await response.json().catch(() => null);
    if (response.status === 404)
      return { ok: false, reason: "This runtime does not support terminal sessions yet." };
    return response.ok
      ? { ok: true, data }
      : { ok: false, reason: reasonOf(data, `Terminal request failed (${response.status}).`) };
  } catch {
    return { ok: false, reason: "Terminal service is not reachable." };
  }
}

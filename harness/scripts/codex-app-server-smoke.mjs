import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

// Real installed protocol check only: no login, credentials, model request, or inference.
const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const codexHome = await mkdtemp(join(tmpdir(), "zet-codex-smoke-"));
const env = { ...process.env, CODEX_HOME: codexHome };
delete env.OPENAI_API_KEY;
delete env.CODEX_API_KEY;
const child = spawn(
  process.execPath,
  [join(root, "node_modules/@openai/codex/bin/codex.js"), "app-server", "--stdio"],
  { cwd: root, env, stdio: "pipe" },
);
child.stderr.resume(); // Never print or preserve private provider diagnostics.
child.stdout.setEncoding("utf8");
const pending = new Map();
let buffer = "";
let nextId = 0;
let exited = false;
let failed = false;
const failure = () => new Error("Isolated Codex app-server smoke check failed.");
const exitPromise = new Promise((resolveExit) => {
  child.once("exit", () => {
    exited = true;
    resolveExit();
  });
  child.once("error", () => {
    exited = true;
    resolveExit();
  });
});
function rejectPending() {
  failed = true;
  for (const request of pending.values()) {
    clearTimeout(request.timer);
    request.reject(failure());
  }
  pending.clear();
}
child.on("error", rejectPending);
child.on("exit", rejectPending);
child.stdout.on("data", (chunk) => {
  buffer += chunk;
  if (Buffer.byteLength(buffer) > 2_000_000) {
    rejectPending();
    child.kill("SIGTERM");
    return;
  }
  while (buffer.includes("\n")) {
    const index = buffer.indexOf("\n");
    const line = buffer.slice(0, index);
    buffer = buffer.slice(index + 1);
    if (!line.trim()) continue;
    let message;
    try {
      message = JSON.parse(line);
    } catch {
      rejectPending();
      child.kill("SIGTERM");
      return;
    }
    if (!message || typeof message !== "object") {
      rejectPending();
      return;
    }
    if (typeof message.method === "string") {
      if (message.id !== undefined)
        child.stdin.write(
          `${JSON.stringify({ id: message.id, error: { code: -32601, message: "Smoke check refuses server requests." } })}\n`,
        );
      continue;
    }
    const request = pending.get(message.id);
    if (!request) continue;
    clearTimeout(request.timer);
    pending.delete(message.id);
    if (message.error !== undefined) request.reject(failure());
    else request.resolve(message.result);
  }
});
function request(method, params) {
  if (failed || exited) return Promise.reject(failure());
  const id = ++nextId;
  return new Promise((resolveRequest, reject) => {
    const timer = setTimeout(() => {
      pending.delete(id);
      reject(failure());
    }, 15_000);
    pending.set(id, { resolve: resolveRequest, reject, timer });
    child.stdin.write(`${JSON.stringify({ id, method, params })}\n`, (error) => {
      if (error) rejectPending();
    });
  });
}
try {
  const initialized = await request("initialize", {
    clientInfo: {
      name: "zet_harness_smoke",
      title: "Z harness isolated smoke check",
      version: "0.1.0",
    },
    capabilities: { experimentalApi: true },
  });
  assert.ok(initialized && typeof initialized === "object", "Missing initialize result.");
  child.stdin.write(`${JSON.stringify({ method: "initialized" })}\n`);
  const account = await request("account/read", { refreshToken: false });
  // Do not print account data, even if the isolation assertion fails.
  if (!account || typeof account !== "object" || account.account !== null) throw failure();
  const models = await request("model/list", { limit: 20 });
  if (!models || !Array.isArray(models.data)) throw failure();
  const permissions = await request("permissionProfile/list", { cwd: root, limit: 20 });
  if (!permissions || !Array.isArray(permissions.data)) throw failure();
  const thread = await request("thread/start", {
    cwd: codexHome,
    ephemeral: true,
    sandbox: "read-only",
    approvalPolicy: "never",
    approvalsReviewer: "user",
    dynamicTools: [
      {
        type: "function",
        name: "zet_smoke_no_execution",
        description: "Protocol registration check only; this tool is never invoked.",
        inputSchema: { type: "object", properties: {}, additionalProperties: false },
      },
    ],
  });
  if (!thread || typeof thread.thread?.id !== "string") throw failure();
  console.log(
    "PASS: installed official experimental dynamic tool registration on an ephemeral read-only thread. No turn or tool was executed.",
  );
  console.log(
    "PASS: installed official Codex app-server initialize/account-read/model-list/permission-profile-list; isolated account is unauthenticated. No login, grant, tool execution or inference.",
  );
} catch {
  process.exitCode = 1;
  console.error("FAIL: isolated installed Codex app-server handshake/account/catalog discovery.");
} finally {
  rejectPending();
  if (!exited) child.kill("SIGTERM");
  const killer = setTimeout(() => {
    if (!exited) child.kill("SIGKILL");
  }, 1000);
  await exitPromise;
  clearTimeout(killer);
  await rm(codexHome, { recursive: true, force: true });
}

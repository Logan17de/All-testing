import { spawn } from "node:child_process";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { RuntimeCodexService } from "./runtime-codex-service.js";
const fixture = `const rl=require('node:readline').createInterface({input:process.stdin});rl.on('line',line=>{const m=JSON.parse(line);if(m.id===undefined)return;if(m.method==='thread/start'){console.log(JSON.stringify({id:'approval-1',method:'item/commandExecution/requestApproval',params:{command:'example',threadId:'t'}}));console.log(JSON.stringify({id:'unsupported',method:'account/chatgptAuthTokens/refresh',params:{}}));console.log(JSON.stringify({method:'turn/completed',params:{threadId:'thread'}}));}console.log(JSON.stringify({id:m.id,result:{method:m.method,params:m.params,...(['thread/start','thread/resume'].includes(m.method)?{thread:{id:'t'}}:{})}}));});`;
function service(timeoutMs = 1000) {
  return new RuntimeCodexService({
    cwd: process.cwd(),
    timeoutMs,
    spawnProcess: () => spawn(process.execPath, ["-e", fixture], { stdio: "pipe" }),
  });
}
describe("official Codex JSONL service (fixture only; no provider calls)", () => {
  it("defers workspace getters until the database-backed runtime is ready", () => {
    let ready = false;
    const codex = new RuntimeCodexService({
      get cwd() {
        if (!ready) throw new Error("Database not open.");
        return process.cwd();
      },
    });
    ready = true;
    expect(codex.snapshot()).toMatchObject({ available: false, scopeGeneration: 0 });
    codex.close();
  });
  it("initializes, enforces safe sandbox, tracks notifications and approval response", async () => {
    const codex = service();
    try {
      const result = (await codex.action("thread/start")) as { params: Record<string, unknown> };
      expect(result.params).toMatchObject({
        sandbox: "read-only",
        approvalPolicy: "on-request",
        approvalsReviewer: "user",
        config: {
          "sandbox_workspace_write.network_access": false,
          "sandbox_workspace_write.writable_roots": [],
        },
      });
      expect(codex.snapshot().events[0]?.method).toBe("turn/completed");
      expect(codex.snapshot().pendingApprovals.map((item) => item.id)).toEqual(["approval-1"]);
      await codex.action("approval/respond", {
        requestGeneration: codex.snapshot().requestGeneration,
        id: "approval-1",
        decision: "decline",
      });
      expect(codex.snapshot().pendingApprovals).toEqual([]);
      expect(codex.snapshot(1).events).toEqual([]);
      await expect(
        codex.action("thread/start", { sandbox: "danger-full-access" }),
      ).rejects.toThrow();
      await expect(codex.action("account/login/start", { type: "chatgpt" })).rejects.toThrow();
    } finally {
      codex.close();
    }
  });
  it("sends official methods with restricted parameters", async () => {
    const codex = service();
    try {
      await expect(
        codex.action("turn/start", { threadId: "unloaded", text: "hello" }),
      ).rejects.toThrow("Resume or start");
      await codex.action("thread/resume", { threadId: "t" });
      expect(
        await codex.action("turn/start", {
          threadId: "t",
          text: "hello",
          cwd: "/",
          approvalPolicy: "never",
        }),
      ).toMatchObject({
        params: {
          cwd: process.cwd(),
          approvalPolicy: "on-request",
          approvalsReviewer: "user",
          sandboxPolicy: { type: "readOnly", networkAccess: false },
          threadId: "t",
          input: [{ type: "text", text: "hello", text_elements: [] }],
        },
      });
      expect(
        await codex.action("thread/resume", { threadId: "t", sandbox: "workspace-write" }),
      ).toMatchObject({ params: { sandbox: "workspace-write" } });
      expect(await codex.action("turn/interrupt", { threadId: "t", turnId: "v" })).toMatchObject({
        params: { threadId: "t", turnId: "v" },
      });
      await expect(
        codex.action("account/login/start", {
          type: "chatgptAuthTokens",
          confirmPersistLogin: true,
        }),
      ).rejects.toThrow();
    } finally {
      codex.close();
    }
    await expect(codex.action("account/read")).rejects.toThrow();
  });
  it("compacts only safely loaded threads and archives without preserving execution authorization", async () => {
    const codex = service();
    try {
      for (const action of ["thread/compact/start", "thread/archive"]) {
        await expect(codex.action(action, { threadId: "t" })).rejects.toThrow("Resume or start");
      }
      await codex.action("thread/resume", { threadId: "t" });
      expect(
        await codex.action("thread/compact/start", { threadId: "t", cwd: "/", model: "safe" }),
      ).toMatchObject({ method: "thread/compact/start", params: { threadId: "t" } });
      expect(await codex.action("thread/archive", { threadId: "t" })).toMatchObject({
        method: "thread/archive",
        params: { threadId: "t" },
      });
      await expect(codex.action("turn/start", { threadId: "t", text: "hello" })).rejects.toThrow(
        "Resume or start",
      );
      expect(await codex.action("thread/unarchive", { threadId: "t" })).toMatchObject({
        method: "thread/unarchive",
        params: { threadId: "t" },
      });
      await expect(codex.action("thread/compact/start", { threadId: "t" })).rejects.toThrow(
        "Resume or start",
      );
      expect(await codex.action("thread/list", { archived: true, cursor: "opaque" })).toMatchObject(
        { params: { archived: true, cursor: "opaque", limit: 50, cwd: process.cwd() } },
      );
      await expect(codex.action("thread/list", { archived: "true" })).rejects.toThrow();
      await expect(
        codex.action("thread/unarchive", { threadId: "x".repeat(513) }),
      ).rejects.toThrow();
      await expect(codex.action("thread/unarchive", { threadId: "t\0" })).rejects.toThrow();
    } finally {
      codex.close();
    }
  });
  it("registers only opted-in fixed tools and executes each call after explicit consent", async () => {
    const root = await mkdtemp(join(tmpdir(), "codex-tools-service-"));
    await writeFile(join(root, "example.txt"), "safe fixture content");
    const codex = new RuntimeCodexService({
      cwd: root,
      spawnProcess: () =>
        spawn(
          process.execPath,
          [
            "-e",
            `
      let response; require('node:readline').createInterface({input:process.stdin}).on('line',line=>{
        const m=JSON.parse(line); if(m.id==='tool'){response=m.result;return;} if(m.id===undefined)return;
        if(m.method==='thread/start') console.log(JSON.stringify({id:'tool',method:'item/tool/call',params:{threadId:'t',turnId:'v',callId:'c',namespace:null,tool:'zet_workspace_read_file',arguments:{path:'example.txt'}}}));
        console.log(JSON.stringify({id:m.id,result:m.method==='model/list'?{response}:{method:m.method,params:m.params,thread:{id:'t'}}}));
      });`,
          ],
          { stdio: "pipe" },
        ),
    });
    try {
      const result = (await codex.action("thread/start", { dynamicToolsEnabled: true })) as {
        params: { dynamicTools: { name: string }[] };
      };
      expect(result.params.dynamicTools.map((tool) => tool.name)).toEqual([
        "zet_workspace_read_file",
        "zet_workspace_list",
      ]);
      const generation = codex.snapshot().requestGeneration;
      await expect(
        codex.action("dynamic-tool/respond", { id: "tool", execute: true }),
      ).rejects.toThrow("generation");
      await expect(
        codex.action("dynamic-tool/respond", {
          id: "tool",
          execute: true,
          requestGeneration: generation,
          command: "arbitrary",
        }),
      ).rejects.toThrow();
      await codex.action("dynamic-tool/respond", {
        id: "tool",
        execute: true,
        requestGeneration: generation,
      });
      expect(await codex.action("model/list")).toMatchObject(
        process.platform === "linux"
          ? {
              response: {
                success: true,
                contentItems: [{ type: "inputText", text: "safe fixture content" }],
              },
            }
          : { response: { success: false } },
      );
      await expect(codex.action("thread/start", { dynamicToolsEnabled: "true" })).rejects.toThrow();
    } finally {
      codex.close();
      await rm(root, { recursive: true, force: true });
    }
  });
  it("expires resolved approvals and refuses duplicate request identifiers", async () => {
    const make = (duplicate: boolean) =>
      new RuntimeCodexService({
        cwd: process.cwd(),
        timeoutMs: 1000,
        spawnProcess: () =>
          spawn(
            process.execPath,
            [
              "-e",
              `
        const rl=require('node:readline').createInterface({input:process.stdin});
        rl.on('line', line => {
          const m=JSON.parse(line); if(m.id===undefined)return;
          if(m.method==='model/list') {
            const a={id:'pending',method:'item/fileChange/requestApproval',params:{threadId:'t',turnId:'v'}};
            console.log(JSON.stringify(a));
            console.log(JSON.stringify(${duplicate ? "a" : "{method:'serverRequest/resolved',params:{threadId:'t',requestId:'pending'}}"}));
          }
          console.log(JSON.stringify({id:m.id,result:{}}));
        });`,
            ],
            { stdio: "pipe" },
          ),
      });
    const resolved = make(false);
    try {
      await resolved.action("model/list");
      expect(resolved.snapshot().pendingApprovals).toEqual([]);
      await expect(
        resolved.action("approval/respond", {
          requestGeneration: resolved.snapshot().requestGeneration,
          id: "pending",
          decision: "accept",
        }),
      ).rejects.toThrow("expired");
    } finally {
      resolved.close();
    }
    const duplicate = make(true);
    try {
      await expect(duplicate.action("model/list")).rejects.toThrow();
      expect(duplicate.snapshot().pendingApprovals).toEqual([]);
    } finally {
      duplicate.close();
    }
  });
  it("validates user answers and MCP form content against pending native requests", async () => {
    const codex = new RuntimeCodexService({
      cwd: process.cwd(),
      spawnProcess: () =>
        spawn(
          process.execPath,
          [
            "-e",
            `
      const rl=require('node:readline').createInterface({input:process.stdin});
      rl.on('line',line=>{const m=JSON.parse(line);if(m.method==='model/list') {
        console.log(JSON.stringify({id:'question',method:'item/tool/requestUserInput',params:{threadId:'t',questions:[{id:'choice',isSecret:true,question:'Choose'}]}}));
        console.log(JSON.stringify({id:'form',method:'mcpServer/elicitation/request',params:{threadId:'t',mode:'form',requestedSchema:{type:'object',properties:{count:{type:'integer',minimum:1},choice:{type:'string',enum:['safe']}},required:['count','choice']}}}));
        console.log(JSON.stringify({id:'url',method:'mcpServer/elicitation/request',params:{threadId:'t',mode:'url',url:'https://example.com/consent'}}));
        for (const [id,url] of [['url-http','http://example.com'],['url-credentials','https://secret@example.com'],['url-invalid','javascript:alert(1)']]) console.log(JSON.stringify({id,method:'mcpServer/elicitation/request',params:{threadId:'t',mode:'url',url}}));
      } if(m.method && m.id!==undefined)console.log(JSON.stringify({id:m.id,result:{}}));
      });`,
          ],
          { stdio: "pipe" },
        ),
    });
    try {
      await codex.action("model/list");
      await expect(
        codex.action("approval/respond", {
          requestGeneration: codex.snapshot().requestGeneration,
          id: "question",
          decision: "accept",
        }),
      ).rejects.toThrow();
      for (const answers of [{ wrong: { answers: ["a"] } }, { choice: { answers: [4] } }, {}]) {
        await expect(
          codex.action("user-input/respond", {
            requestGeneration: codex.snapshot().requestGeneration,
            id: "question",
            answers,
          }),
        ).rejects.toThrow();
      }
      await codex.action("user-input/respond", {
        requestGeneration: codex.snapshot().requestGeneration,
        id: "question",
        answers: { choice: { answers: ["private answer"] } },
      });
      await expect(
        codex.action("user-input/respond", {
          requestGeneration: codex.snapshot().requestGeneration,
          id: "question",
          answers: { choice: { answers: ["again"] } },
        }),
      ).rejects.toThrow("expired");
      for (const content of [
        { count: 0, choice: "safe" },
        { count: 2, choice: "unsafe" },
        { count: 2, choice: "safe", extra: true },
      ]) {
        await expect(
          codex.action("elicitation/respond", {
            requestGeneration: codex.snapshot().requestGeneration,
            id: "form",
            action: "accept",
            content,
          }),
        ).rejects.toThrow();
      }
      await codex.action("elicitation/respond", {
        requestGeneration: codex.snapshot().requestGeneration,
        id: "form",
        action: "accept",
        content: { count: 2, choice: "safe" },
      });
      await expect(
        codex.action("elicitation/respond", {
          requestGeneration: codex.snapshot().requestGeneration,
          id: "form",
          action: "cancel",
        }),
      ).rejects.toThrow("expired");
      await expect(
        codex.action("elicitation/respond", {
          requestGeneration: codex.snapshot().requestGeneration,
          id: "url",
          action: "accept",
        }),
      ).rejects.toThrow("External URL consent");
      for (const id of ["url-http", "url-credentials", "url-invalid"]) {
        await expect(
          codex.action("elicitation/respond", {
            requestGeneration: codex.snapshot().requestGeneration,
            id,
            action: "accept",
            confirmExternalConsent: true,
          }),
        ).rejects.toThrow("valid HTTPS");
        await codex.action("elicitation/respond", {
          requestGeneration: codex.snapshot().requestGeneration,
          id,
          action: "cancel",
        });
      }
      await expect(
        codex.action("elicitation/respond", {
          requestGeneration: codex.snapshot().requestGeneration,
          id: "url",
          action: "accept",
          confirmExternalConsent: true,
          content: { token: "private" },
        }),
      ).rejects.toThrow();
      await codex.action("elicitation/respond", {
        requestGeneration: codex.snapshot().requestGeneration,
        id: "url",
        action: "accept",
        confirmExternalConsent: true,
        content: null,
      });
      await expect(
        codex.action("elicitation/respond", {
          requestGeneration: codex.snapshot().requestGeneration,
          id: "url",
          action: "accept",
          confirmExternalConsent: true,
        }),
      ).rejects.toThrow("expired");
      expect(codex.snapshot().pendingApprovals).toEqual([]);
      expect(JSON.stringify(codex.snapshot())).not.toContain("private answer");
    } finally {
      codex.close();
    }
  });
  it("consumes stream EPIPE errors and isolates errors from stopped transports", async () => {
    let child: ReturnType<typeof spawn>;
    const codex = new RuntimeCodexService({
      cwd: process.cwd(),
      spawnProcess: () => {
        const spawned = spawn(process.execPath, ["-e", fixture], { stdio: "pipe" });
        child = spawned;
        return spawned;
      },
    });
    try {
      await codex.action("model/list");
      const old = child!;
      expect(
        old.stdin!.emit("error", Object.assign(new Error("private stderr"), { code: "EPIPE" })),
      ).toBe(true);
      expect(codex.snapshot().available).toBe(false);
      await codex.action("model/list");
      old.stdin!.emit("error", new Error("late EPIPE"));
      expect(codex.snapshot().available).toBe(true);
    } finally {
      codex.close();
    }
  });
  it("bounds timeouts and suppresses provider diagnostics", async () => {
    const codex = new RuntimeCodexService({
      cwd: process.cwd(),
      timeoutMs: 30,
      spawnProcess: () =>
        spawn(
          process.execPath,
          ["-e", "console.error('private-secret');setInterval(()=>{},1000)"],
          { stdio: "pipe" },
        ),
    });
    try {
      await expect(codex.action("account/read")).rejects.toThrow(
        "Codex app-server unavailable or protocol request failed.",
      );
    } finally {
      codex.close();
    }
  });
});

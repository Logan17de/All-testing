import { spawn } from "node:child_process";
import { describe, expect, it } from "vitest";
import { RuntimeCodexService } from "./runtime-codex-service.js";
const fixture = `const rl=require('node:readline').createInterface({input:process.stdin});rl.on('line',line=>{const m=JSON.parse(line);if(m.id===undefined)return;if(m.method==='thread/start'){console.log(JSON.stringify({id:'approval-1',method:'item/commandExecution/requestApproval',params:{command:'example',threadId:'t'}}));console.log(JSON.stringify({id:'unsupported',method:'item/permissions/requestApproval',params:{}}));console.log(JSON.stringify({method:'turn/completed',params:{threadId:'thread'}}));}console.log(JSON.stringify({id:m.id,result:{method:m.method,params:m.params,...(['thread/start','thread/resume'].includes(m.method)?{thread:{id:'t'}}:{})}}));});`;
function service(timeoutMs = 1000) {
  return new RuntimeCodexService({
    cwd: process.cwd(),
    timeoutMs,
    spawnProcess: () => spawn(process.execPath, ["-e", fixture], { stdio: "pipe" }),
  });
}
describe("official Codex JSONL service (fixture only; no provider calls)", () => {
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
      await codex.action("approval/respond", { id: "approval-1", decision: "decline" });
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
        resolved.action("approval/respond", { id: "pending", decision: "accept" }),
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
        codex.action("approval/respond", { id: "question", decision: "accept" }),
      ).rejects.toThrow();
      for (const answers of [{ wrong: { answers: ["a"] } }, { choice: { answers: [4] } }, {}]) {
        await expect(
          codex.action("user-input/respond", { id: "question", answers }),
        ).rejects.toThrow();
      }
      await codex.action("user-input/respond", {
        id: "question",
        answers: { choice: { answers: ["private answer"] } },
      });
      await expect(
        codex.action("user-input/respond", {
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
          codex.action("elicitation/respond", { id: "form", action: "accept", content }),
        ).rejects.toThrow();
      }
      await codex.action("elicitation/respond", {
        id: "form",
        action: "accept",
        content: { count: 2, choice: "safe" },
      });
      await expect(
        codex.action("elicitation/respond", { id: "form", action: "cancel" }),
      ).rejects.toThrow("expired");
      await expect(
        codex.action("elicitation/respond", { id: "url", action: "accept" }),
      ).rejects.toThrow("External URL consent");
      for (const id of ["url-http", "url-credentials", "url-invalid"]) {
        await expect(
          codex.action("elicitation/respond", {
            id,
            action: "accept",
            confirmExternalConsent: true,
          }),
        ).rejects.toThrow("valid HTTPS");
        await codex.action("elicitation/respond", { id, action: "cancel" });
      }
      await expect(
        codex.action("elicitation/respond", {
          id: "url",
          action: "accept",
          confirmExternalConsent: true,
          content: { token: "private" },
        }),
      ).rejects.toThrow();
      await codex.action("elicitation/respond", {
        id: "url",
        action: "accept",
        confirmExternalConsent: true,
        content: null,
      });
      await expect(
        codex.action("elicitation/respond", {
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

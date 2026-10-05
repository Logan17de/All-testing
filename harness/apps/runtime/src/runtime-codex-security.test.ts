import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { describe, expect, it } from "vitest";
import { RuntimeCodexService } from "./runtime-codex-service.js";

const fixture = `
const rl=require('node:readline').createInterface({input:process.stdin});
rl.on('line',line=>{
 const m=JSON.parse(line); if(!m.method || m.id===undefined) return;
 if(m.method==='model/list') {
  console.log(JSON.stringify({id:'old-approval',method:'item/fileChange/requestApproval',params:{threadId:'old-thread',turnId:'turn',grantRoot:'/old-root'}}));
  console.log(JSON.stringify({method:'item/agentMessage/delta',params:{threadId:'old-thread',delta:'old workspace private content'}}));
 }
 console.log(JSON.stringify({id:m.id,result:{thread:{id:'old-thread'},params:m.params}}));
});`;

describe("Codex workspace scope boundary (fixture only)", () => {
  it("invalidates old workspace approvals, threads and retained events when the root changes", async () => {
    let cwd = process.cwd();
    let child: ChildProcessWithoutNullStreams | undefined;
    const service = new RuntimeCodexService({
      get cwd() {
        return cwd;
      },
      spawnProcess: () => {
        child = spawn(process.execPath, ["-e", fixture], { stdio: "pipe" });
        return child;
      },
    });
    try {
      await service.action("thread/start", { sandbox: "workspace-write" });
      await service.action("model/list");
      const before = service.snapshot();
      expect(before.pendingApprovals).toHaveLength(1);
      expect(before.events).toHaveLength(1);
      cwd = "/tmp";
      const after = service.snapshot();
      expect(after.available).toBe(false);
      expect(after.pendingApprovals).toEqual([]);
      expect(after.events).toEqual([]);
      expect(after.cursor).toBeGreaterThanOrEqual(before.cursor);
      // Simulate trailing data already queued by the old transport after shutdown.
      child!.stdout.emit(
        "data",
        JSON.stringify({
          id: "stale",
          method: "item/fileChange/requestApproval",
          params: { threadId: "old-thread" },
        }) + "\n",
      );
      child!.stdout.emit(
        "data",
        JSON.stringify({
          method: "item/agentMessage/delta",
          params: { delta: "late private content" },
        }) + "\n",
      );
      expect(service.snapshot().pendingApprovals).toEqual([]);
      expect(service.snapshot().events).toEqual([]);
      await expect(
        service.action("approval/respond", { id: "old-approval", decision: "accept" }),
      ).rejects.toThrow();
      await expect(
        service.action("turn/start", { threadId: "old-thread", text: "write" }),
      ).rejects.toThrow("Resume or start");
      const resumed = (await service.action("thread/resume", { threadId: "old-thread" })) as {
        params: Record<string, unknown>;
      };
      expect(resumed.params.cwd).toBe("/tmp");
      expect(resumed.params.sandbox).toBe("read-only");
    } finally {
      service.close();
    }
  });
  it("bounds aggregate pending native request payloads", async () => {
    const service = new RuntimeCodexService({
      cwd: process.cwd(),
      spawnProcess: () =>
        spawn(
          process.execPath,
          [
            "-e",
            `
      require('node:readline').createInterface({input:process.stdin}).on('line',line=>{
        const m=JSON.parse(line);if(!m.method||m.id===undefined)return;
        if(m.method==='model/list')for(let i=0;i<6;i++)console.log(JSON.stringify({id:'large-'+i,method:'item/fileChange/requestApproval',params:{threadId:'t',reason:'x'.repeat(900000)}}));
        console.log(JSON.stringify({id:m.id,result:{}}));
      });`,
          ],
          { stdio: "pipe" },
        ),
    });
    try {
      await service.action("model/list");
      const pending = service.snapshot().pendingApprovals;
      expect(pending.length).toBeGreaterThan(0);
      expect(pending.length).toBeLessThan(6);
      expect(Buffer.byteLength(JSON.stringify(pending))).toBeLessThanOrEqual(4_000_000);
      await expect(
        service.action("approval/respond", { id: "large-5", decision: "accept" }),
      ).rejects.toThrow("expired");
    } finally {
      service.close();
    }
  });
});

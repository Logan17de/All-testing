import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { McpStdioClient } from "./mcp-client.js";

it("settles cancellation promptly, notifies stdio server, and ignores late responses", async () => {
  const root = await mkdtemp(join(tmpdir(), "zet-mcp-cancel-"));
  const script = join(root, "server.cjs");
  await writeFile(
    script,
    `
const readline = require('node:readline');
const send = (id, result) => process.stdout.write(JSON.stringify({jsonrpc:'2.0',id,result})+'\\n');
let cancelled = false;
readline.createInterface({input:process.stdin}).on('line', line => {
 const m = JSON.parse(line);
 if(m.method === 'initialize') send(m.id,{protocolVersion:'2025-06-18',capabilities:{tools:{}},serverInfo:{name:'fixture',version:'1'}});
 if(m.method === 'notifications/cancelled') cancelled = typeof m.params.requestId === 'number' && m.params.reason === 'Request cancelled';
 if(m.method === 'tools/call') {
  if(m.params.name === 'wait') setTimeout(()=>send(m.id,{content:[{type:'text',text:'late'}]}),100);
  else send(m.id,{content:[{type:'text',text:String(cancelled)}]});
 }
});
`,
  );
  const client = new McpStdioClient({
    command: process.execPath,
    args: [script],
    requestTimeoutMs: 5_000,
  });
  try {
    client.start();
    await client.initialize();
    const controller = new AbortController();
    const pending = client.callTool("wait", {}, controller.signal);
    const rejection = expect(pending).rejects.toThrow("fixture cancelled");
    controller.abort(new Error("fixture cancelled"));
    await rejection;
    expect((await client.callTool("inspect", {})).content[0]?.text).toBe("true");
    // A late response to the cancelled ID must not settle another request.
    await new Promise<void>((resolve) => setTimeout(resolve, 150));
    expect((await client.callTool("inspect", {})).content[0]?.text).toBe("true");
    const before = new AbortController();
    before.abort(new Error("already cancelled"));
    await expect(client.callTool("wait", {}, before.signal)).rejects.toThrow("already cancelled");
  } finally {
    await client.close();
    await rm(root, { recursive: true, force: true });
  }
});

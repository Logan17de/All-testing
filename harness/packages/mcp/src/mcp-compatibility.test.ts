import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import type { AdapterInvocationContext } from "@zet-harness/plugin-api";
import { connectMcpServer } from "./mcp-tools.js";

function invocation(signal = new AbortController().signal): AdapterInvocationContext {
  return {
    runId: "fixture",
    opIndex: 0,
    iteration: 0,
    attempt: 1,
    logicalEffectId: "fixture",
    signal,
    retryBudget: {
      maxAttempts: 1,
      repeatAuthorized: false,
      usedAttempts: 1,
      remainingAttempts: 0,
      reportInternalRetries: () => 0,
    },
  };
}

it("real stdio isolates incompatible descriptors, validates before execution and preserves cancellation", async () => {
  const directory = await mkdtemp(join(tmpdir(), "zet-mcp-compatibility-"));
  const script = join(directory, "server.cjs");
  await writeFile(
    script,
    `
const readline = require('node:readline');
const send = (id,result) => process.stdout.write(JSON.stringify({jsonrpc:'2.0',id,result})+'\\n');
let calls = 0, cancelled = false;
readline.createInterface({input:process.stdin}).on('line', line => {
 const m = JSON.parse(line);
 if(m.method === 'initialize') send(m.id,{protocolVersion:'2025-06-18',capabilities:{tools:{}},serverInfo:{name:'compatibility-fixture',version:'1'}});
 if(m.method === 'tools/list') send(m.id,{tools:[
  {name:'compatible',inputSchema:{type:'object',$defs:{slug:{type:'string',pattern:'^[a-z]{1,8}$'}},required:['slug'],properties:{slug:{$ref:'#/$defs/slug'},tuple:{prefixItems:[{type:'boolean'}],items:false}}}},
  {name:'unsafe',inputSchema:{properties:{text:{pattern:'(a+)+$'}},description:'private schema diagnostic'}},
  {name:'external',inputSchema:{$ref:'https://remote.example/private'}},
  {name:'recursive',inputSchema:{$defs:{x:{$ref:'#/$defs/x'}}}},
  {name:'missing'}, null,
  {name:'bad/name',inputSchema:{}},
  {name:'compatible',inputSchema:{}},
  {name:'inspect',inputSchema:{}},
  {name:'wait',inputSchema:{}},
 ]});
 if(m.method === 'notifications/cancelled') cancelled = true;
 if(m.method === 'tools/call') {
  if(m.params.name === 'inspect') send(m.id,{content:[{type:'text',text:JSON.stringify({calls,cancelled})}]});
  else if(m.params.name === 'wait') setTimeout(()=>send(m.id,{content:[{type:'text',text:'late'}]}),100);
  else { calls++; send(m.id,{content:[{type:'text',text:'accepted'}]}); }
 }
});
`,
  );
  const connection = await connectMcpServer({
    id: "fixture",
    command: process.execPath,
    args: [script],
    requestTimeoutMs: 5000,
  });
  try {
    expect(connection.adapters.map((adapter) => adapter.manifest.id)).toEqual([
      "mcp.fixture.compatible",
      "mcp.fixture.inspect",
      "mcp.fixture.wait",
    ]);
    expect(connection.diagnostics.map((diagnostic) => diagnostic.reason)).toEqual([
      "missing-input-schema",
      "invalid-descriptor",
      "unsupported-input-schema",
      "unsupported-input-schema",
      "unsupported-input-schema",
      "invalid-tool-name",
      "duplicate-tool-name",
    ]);
    expect(JSON.stringify(connection.diagnostics)).not.toContain("private");
    expect(Object.isFrozen(connection.diagnostics)).toBe(true);
    expect(connection.diagnostics.every(Object.isFrozen)).toBe(true);
    const compatible = connection.adapters[0]!;
    await expect(compatible.invoke({ slug: "UPPER" }, invocation())).rejects.toThrow(
      "validation failed",
    );
    await expect(
      compatible.invoke({ slug: "ok", tuple: [true, false] }, invocation()),
    ).rejects.toThrow("validation failed");
    expect((await connection.client.callTool("inspect", {})).content[0]?.text).toBe(
      '{"calls":0,"cancelled":false}',
    );
    await compatible.invoke({ slug: "ok", tuple: [true] }, invocation());
    expect((await connection.client.callTool("inspect", {})).content[0]?.text).toBe(
      '{"calls":1,"cancelled":false}',
    );
    const controller = new AbortController();
    const wait = connection.adapters[2]!.invoke({}, invocation(controller.signal));
    const rejection = expect(wait).rejects.toThrow("fixture cancelled");
    controller.abort(new Error("fixture cancelled"));
    await rejection;
    expect((await connection.client.callTool("inspect", {})).content[0]?.text).toBe(
      '{"calls":1,"cancelled":true}',
    );
    await new Promise<void>((resolve) => setTimeout(resolve, 150));
    expect((await connection.client.callTool("inspect", {})).content[0]?.text).toBe(
      '{"calls":1,"cancelled":true}',
    );
  } finally {
    await connection.close();
    await rm(directory, { recursive: true, force: true });
  }
});

import { spawn, type ChildProcess } from "node:child_process";
import { createServer, type Server } from "node:net";
import { afterEach, describe, expect, it } from "vitest";

import {
  listeningProcessId,
  portInUse,
  stopProcessTree,
  treeSpawnOptions,
} from "./process-tree.mjs";

const children: ChildProcess[] = [];
const servers: Server[] = [];

afterEach(async () => {
  for (const child of children.splice(0)) await stopProcessTree(child, { force: true });
  for (const server of servers.splice(0)) server.close();
});

/** A server started the way `npm start` starts one: by a parent that is not the server. */
const GRANDCHILD = `
const server = require("node:http").createServer(() => {});
server.listen(0, "127.0.0.1", () => {
  console.log("PORT " + server.address().port);
  console.log("PID " + process.pid);
});
`;

const PARENT = `
const { spawn } = require("node:child_process");
spawn(process.execPath, ["-e", ${JSON.stringify(GRANDCHILD)}], { stdio: "inherit" });
setInterval(() => {}, 1000);
`;

async function startTree(): Promise<{ child: ChildProcess; port: number; serverPid: number }> {
  const child = spawn(process.execPath, ["-e", PARENT], {
    stdio: ["ignore", "pipe", "inherit"],
    ...treeSpawnOptions(),
  });
  children.push(child);
  let output = "";
  child.stdout?.setEncoding("utf8");
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new Error(`The server never reported its port: ${output}`));
    }, 10_000);
    child.stdout?.on("data", (chunk: string) => {
      output += chunk;
      const port = /PORT (\d+)/u.exec(output)?.[1];
      const pid = /PID (\d+)/u.exec(output)?.[1];
      if (port !== undefined && pid !== undefined) {
        clearTimeout(timer);
        resolve({ child, port: Number(port), serverPid: Number(pid) });
      }
    });
  });
}

async function eventually(check: () => Promise<boolean>, timeoutMs = 10_000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await check()) return true;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  return false;
}

describe("stopping what npm start started", () => {
  it("stops the server a child started, not just the child", async () => {
    const { child, port } = await startTree();
    expect(await portInUse(port)).toBe(true);

    await stopProcessTree(child, { force: true });

    // Stopping only the parent would leave the server holding its port.
    expect(await eventually(async () => !(await portInUse(port)))).toBe(true);
    expect(
      await eventually(() => Promise.resolve(child.exitCode !== null || child.signalCode !== null)),
    ).toBe(true);
  }, 30_000);

  it.runIf(process.platform === "win32")(
    "names the process holding a port, so a leftover one can be found",
    async () => {
      const { port, serverPid } = await startTree();
      expect(await listeningProcessId(port)).toBe(serverPid);
    },
    30_000,
  );
});

describe("noticing what is already running", () => {
  it("tells a taken port from a free one", async () => {
    const server = createServer();
    servers.push(server);
    await new Promise<void>((resolve) => {
      server.listen(0, "127.0.0.1", () => {
        resolve();
      });
    });
    const address = server.address();
    const port = typeof address === "object" && address !== null ? address.port : 0;
    expect(await portInUse(port)).toBe(true);

    await new Promise<void>((resolve) => {
      server.close(() => {
        resolve();
      });
    });
    servers.splice(0);
    expect(await portInUse(port)).toBe(false);
  });
});

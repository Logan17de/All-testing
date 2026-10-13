import { spawn, type ChildProcess } from "node:child_process";
import { once } from "node:events";
import { copyFile, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";

import { portInUse, stopProcessTree, treeSpawnOptions } from "./process-tree.mjs";

const source = dirname(fileURLToPath(import.meta.url));
const roots: string[] = [];
const children: ChildProcess[] = [];

async function waitUntil(check: () => boolean | Promise<boolean>): Promise<void> {
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    if (await check()) return;
    await new Promise((done) => setTimeout(done, 30));
  }
  throw new Error("Launcher fixture did not settle within ten seconds.");
}

afterEach(async () => {
  for (const child of children.splice(0)) {
    if (child.exitCode !== null || child.signalCode !== null) continue;
    if (process.platform === "win32") await stopProcessTree(child, { force: true });
    else child.kill("SIGTERM");
    await waitUntil(() => child.exitCode !== null || child.signalCode !== null);
  }
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});

async function freePort(): Promise<number> {
  const server = createServer();
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  if (address === null || typeof address === "string") throw new Error("No fixture port.");
  await new Promise<void>((done, reject) =>
    server.close((error) => (error ? reject(error) : done())),
  );
  return address.port;
}

async function fixture(options: { built?: boolean; distDir?: string } = {}) {
  const root = await mkdtemp(join(tmpdir(), "zet-launcher-"));
  roots.push(root);
  const webRoot = join(root, "apps", "web");
  const runtimeRoot = join(root, "apps", "runtime");
  const nextRoot = join(webRoot, "node_modules", "next");
  const npmCli = join(root, "portable-npm.cjs");
  for (const path of [
    join(root, "scripts"),
    join(runtimeRoot, "dist"),
    join(nextRoot, "dist", "bin"),
  ]) {
    await mkdir(path, { recursive: true });
  }
  for (const name of ["start-harness.mjs", "process-tree.mjs"]) {
    await copyFile(join(source, name), join(root, "scripts", name));
  }
  await writeFile(join(nextRoot, "package.json"), '{"name":"next","version":"0.0.0"}');
  await writeFile(join(webRoot, "package.json"), '{"name":"fixture-web"}');
  await writeFile(
    join(webRoot, "next.config.mjs"),
    `export default { distDir: ${JSON.stringify(options.distDir ?? ".next")} };`,
  );
  await writeFile(
    join(nextRoot, "dist", "bin", "next"),
    `const http = require("node:http");
const args = process.argv.slice(2);
const port = Number(args[args.indexOf("-p") + 1]);
const host = args[args.indexOf("-H") + 1];
http.createServer((_, response) => response.end("Zet Harness")).listen(port, host, () => {
  console.log("WEB_READY " + args[0] + " " + process.env.NODE_ENV + " " + host);
});`,
  );
  await writeFile(
    join(runtimeRoot, "dist", "main.js"),
    `const http = require("node:http");
http.createServer((_, response) => response.end('{"service":"zet-harness-runtime"}'))
  .listen(Number(process.env.ZET_RUNTIME_PORT), "127.0.0.1", () => {
    console.log("RUNTIME_READY " + process.env.NODE_ENV);
    if (process.env.FIXTURE_RUNTIME_FAILURE === "1") setTimeout(() => process.exit(19), 200);
  });`,
  );
  await writeFile(
    npmCli,
    `console.log("RUNTIME_BUILD " + process.argv.slice(2).join(" "));
setTimeout(() => process.exit(Number(process.env.FIXTURE_BUILD_EXIT ?? "0")), 300);`,
  );
  if (options.built) {
    await mkdir(join(webRoot, ".next"));
    await writeFile(join(webRoot, ".next", "BUILD_ID"), "fixture-build");
  }
  const webPort = await freePort();
  let runtimePort = await freePort();
  while (runtimePort === webPort) runtimePort = await freePort();
  return {
    root,
    webPort,
    runtimePort,
    launch(args: string[] = [], environment: NodeJS.ProcessEnv = {}) {
      const child = spawn(process.execPath, [join(root, "scripts", "start-harness.mjs"), ...args], {
        cwd: root,
        env: {
          ...Object.fromEntries(
            Object.entries(process.env).filter(([key]) => key.toLowerCase() !== "npm_execpath"),
          ),
          npm_execpath: npmCli,
          PORT: String(webPort),
          ZET_RUNTIME_PORT: String(runtimePort),
          ...environment,
        },
        stdio: ["ignore", "pipe", "pipe"],
        ...treeSpawnOptions(),
      });
      children.push(child);
      let output = "";
      for (const stream of [child.stdout, child.stderr]) {
        stream?.setEncoding("utf8");
        stream?.on("data", (chunk: string) => {
          output += chunk;
        });
      }
      return { child, output: () => output };
    },
  };
}

describe("local production launcher", () => {
  it("refuses an unbuilt production restart before starting or stopping servers", async () => {
    const local = await fixture();
    const run = local.launch(["--production", "--restart"]);
    await waitUntil(() => run.child.exitCode !== null);
    expect(run.child.exitCode).toBe(1);
    expect(run.output()).toContain("nothing was started or stopped");
    expect(run.output()).not.toContain("RUNTIME_BUILD");
    expect(await portInUse(local.webPort)).toBe(false);
    expect(await portInUse(local.runtimePort)).toBe(false);
  });

  it("checks the configured output directory instead of accepting an unrelated build", async () => {
    const local = await fixture({ built: true, distDir: ".next-review" });
    const run = local.launch(["--production"]);
    await waitUntil(() => run.child.exitCode !== null);
    expect(run.child.exitCode).toBe(1);
    expect(run.output()).toContain("Production build is missing");
  });

  it("serves prebuilt production processes on loopback without invoking npm", async () => {
    const local = await fixture({ built: true });
    const run = local.launch(["--production"], {
      NODE_ENV: "development",
      npm_execpath: "missing-npm",
    });
    await waitUntil(
      () => run.output().includes("WEB_READY") && run.output().includes("RUNTIME_READY"),
    );
    expect(run.output()).toContain("WEB_READY start production 127.0.0.1");
    expect(run.output()).toContain("RUNTIME_READY production");
    expect(run.output()).not.toContain("RUNTIME_BUILD");
    expect(await portInUse(local.webPort)).toBe(true);
    expect(await portInUse(local.runtimePort)).toBe(true);
  });

  it("preserves development startup using the npm entry that invoked the launcher", async () => {
    const local = await fixture();
    const run = local.launch([], { NODE_ENV: "production" });
    await waitUntil(
      () => run.output().includes("WEB_READY") && run.output().includes("RUNTIME_READY"),
    );
    expect(run.output()).toContain("WEB_READY dev development 127.0.0.1");
    expect(run.output()).toContain("RUNTIME_BUILD run build --workspace @zet-harness/runtime");
  });

  it("stops the development UI when the runtime build fails", async () => {
    const local = await fixture();
    const run = local.launch(["--dev"], { FIXTURE_BUILD_EXIT: "17" });
    await waitUntil(() => run.child.exitCode !== null);
    expect(run.child.exitCode).toBe(17);
    expect(run.output()).toContain("build failed");
    expect(run.output()).not.toContain("RUNTIME_READY");
    expect(await portInUse(local.webPort)).toBe(false);
  });

  it("stops the production UI and preserves the failure when the runtime exits", async () => {
    const local = await fixture({ built: true });
    const run = local.launch(["--production"], { FIXTURE_RUNTIME_FAILURE: "1" });
    await waitUntil(() => run.child.exitCode !== null);
    expect(run.child.exitCode).toBe(19);
    expect(await portInUse(local.webPort)).toBe(false);
    expect(await portInUse(local.runtimePort)).toBe(false);
  });

  it("rejects contradictory modes without launching anything", async () => {
    const local = await fixture({ built: true });
    const run = local.launch(["--production", "--dev"]);
    await waitUntil(() => run.child.exitCode !== null);
    expect(run.child.exitCode).toBe(1);
    expect(run.output()).toContain("Usage:");
    expect(run.output()).not.toContain("Starting Zet Harness");
  });
});

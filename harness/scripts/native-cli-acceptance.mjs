// Real local HTTP/CLI checks; no provider calls or persistent user credentials.
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { RuntimeDaemon } from "../apps/runtime/dist/runtime-daemon.js";
import { runAgentCommand } from "./agent-cli.mjs";
const directory = await mkdtemp(join(tmpdir(), "zet-native-cli-"));
const daemon = new RuntimeDaemon({
  api: { port: 0 },
  database: { path: join(directory, "runtime.sqlite") },
  probePathLimits: false,
  plugins: { directory: join(directory, "plugins") },
});
try {
  await daemon.start();
  const origin = `http://127.0.0.1:${daemon.snapshot().api.port}`;
  const invoke = async (args) => JSON.parse(await runAgentCommand([...args, "--runtime", origin]));
  const status = await invoke(["status"]);
  if (status.engine !== "native") throw new Error("wrong engine");
  const created = await invoke(["start", "--title", "Offline CLI acceptance"]);
  const id = created.session.id;
  await invoke(["read", "--session", id]);
  await invoke(["archive", "--session", id]);
  await invoke(["restore", "--session", id]);
  const listed = await invoke(["sessions"]);
  if (!listed.data.some((s) => s.id === id)) throw new Error("session unavailable");
  const auth = await (await fetch(`${origin}/api/auth/chatgpt`)).json();
  if (auth.state !== "disconnected") throw new Error("auth unexpectedly active");
  console.log(
    "CLI_NATIVE_SMOKE_OK engine=native sessions=ok read=ok archive=ok restore=ok auth=disconnected",
  );
} finally {
  await daemon.stop();
  await rm(directory, { recursive: true, force: true });
}

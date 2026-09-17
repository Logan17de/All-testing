/**
 * Stopping what `npm start` started, and noticing what is already running.
 *
 * `npm start` launches each half through npm, which launches a shell, which
 * launches the real server. Killing the npm process only ends that one process:
 * on Windows the server underneath keeps running with no parent, holding its port,
 * and the next `npm start` fails with "port in use" or "another next dev server".
 * So a shutdown stops the whole tree — `taskkill /T` on Windows, the process group
 * elsewhere, which is why children are started in their own group there.
 */
import { spawn } from "node:child_process";
import { connect } from "node:net";
import { join } from "node:path";

const isWindows = process.platform === "win32";

function system32(executable) {
  return join(process.env.SystemRoot ?? "C:\\Windows", "System32", executable);
}

/** Options for starting a child that `stopProcessTree` can stop completely. */
export function treeSpawnOptions() {
  // A POSIX child in its own process group can be signalled together with
  // everything it starts. Windows has no groups to signal; taskkill walks the tree.
  return isWindows ? {} : { detached: true };
}

/** Stop a child and everything it started. Resolves once the stop was issued. */
export function stopProcessTree(child, { force = false } = {}) {
  const pid = child.pid;
  if (pid === undefined || child.exitCode !== null || child.signalCode !== null) {
    return Promise.resolve();
  }
  return stopProcessId(pid, { force, fallback: child });
}

/**
 * Stop a process by id, with everything it started.
 *
 * On POSIX this signals the process group the id leads, which is what a child
 * started with `treeSpawnOptions()` is; a process that leads no group is
 * signalled on its own.
 */
export function stopProcessId(pid, { force = false, fallback } = {}) {
  if (isWindows) {
    return new Promise((resolve) => {
      const killer = spawn(
        system32("taskkill.exe"),
        ["/PID", String(pid), "/T", ...(force ? ["/F"] : [])],
        { stdio: "ignore", shell: false, windowsHide: true },
      );
      killer.on("error", () => {
        resolve();
      });
      killer.on("exit", () => {
        resolve();
      });
    });
  }
  const signal = force ? "SIGKILL" : "SIGTERM";
  try {
    process.kill(-pid, signal);
  } catch {
    try {
      if (fallback === undefined) process.kill(pid, signal);
      else fallback.kill(signal);
    } catch {
      // Already gone.
    }
  }
  return Promise.resolve();
}

/** Whether something already accepts connections on this loopback port. */
export function portInUse(port, host = "127.0.0.1", timeoutMs = 500) {
  return new Promise((resolve) => {
    const socket = connect({ port, host });
    const finish = (value) => {
      socket.destroy();
      resolve(value);
    };
    socket.setTimeout(timeoutMs, () => {
      finish(false);
    });
    socket.once("connect", () => {
      finish(true);
    });
    socket.once("error", () => {
      finish(false);
    });
  });
}

/**
 * The process listening on a loopback port, where the system can say.
 *
 * Windows only, from `netstat -ano`, run without a shell; elsewhere the answer is
 * left to the person, because the tools and their output differ too much.
 */
export function listeningProcessId(port) {
  if (!isWindows) return Promise.resolve(undefined);
  return new Promise((resolve) => {
    let output = "";
    const netstat = spawn(system32("netstat.exe"), ["-ano", "-p", "TCP"], {
      stdio: ["ignore", "pipe", "ignore"],
      shell: false,
      windowsHide: true,
    });
    netstat.stdout.setEncoding("utf8");
    netstat.stdout.on("data", (chunk) => {
      output += chunk;
    });
    netstat.on("error", () => {
      resolve(undefined);
    });
    netstat.on("exit", () => {
      for (const line of output.split(/\r?\n/u)) {
        const columns = line.trim().split(/\s+/u);
        // Proto  Local Address  Foreign Address  State  PID
        if (columns.length < 5 || columns[3] !== "LISTENING") continue;
        if (columns[1]?.endsWith(`:${String(port)}`)) {
          const pid = Number(columns[4]);
          resolve(Number.isSafeInteger(pid) && pid > 0 ? pid : undefined);
          return;
        }
      }
      resolve(undefined);
    });
  });
}

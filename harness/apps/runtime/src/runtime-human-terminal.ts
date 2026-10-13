import { realpath, lstat } from "node:fs/promises";
import {
  fixedHumanTerminalShell,
  launchTerminalJob,
  type TerminalJobTransport,
} from "./runtime-terminal-job-launcher.js";
import { TerminalError, type SandboxedTerminalAdapter } from "./runtime-terminal-service.js";
/** Inherited current Windows token only; this factory never elevates, changes
 * identity, creates AppContainer profiles, or serves as agent sandbox fallback. */
export async function createHumanConPtyAdapter(authority: {
  windowsIdentity: string;
  shell: string;
}): Promise<SandboxedTerminalAdapter> {
  if (
    !authority.windowsIdentity ||
    authority.windowsIdentity.length > 256 ||
    authority.shell !== (await fixedHumanTerminalShell())
  )
    throw new TerminalError(
      "TERMINAL_AUTHORITY_INVALID",
      "Actual Windows identity and fixed canonical shell required.",
      409,
    );
  return {
    authority: { ...authority },
    capabilities: {
      interactive: true,
      input: true,
      resize: true,
      interrupt: true,
      mode: "human-host-pty",
    },
    async launch(request) {
      const grant = request.grant;
      if (
        !grant ||
        grant.ownerKey !== request.identity.ownerKey ||
        grant.conversationId !== request.identity.conversationId ||
        grant.cwd !== request.cwd ||
        grant.shell !== authority.shell ||
        grant.windowsIdentity !== authority.windowsIdentity ||
        !/^[A-Za-z0-9_-]{32,128}$/u.test(grant.nonce) ||
        !Number.isSafeInteger(grant.expiresAt) ||
        grant.expiresAt <= Date.now()
      )
        throw new TerminalError(
          "TERMINAL_GRANT_REQUIRED",
          "Current exact human authority grant required.",
          403,
        );
      const cwdInfo = await lstat(request.cwd);
      if (
        !cwdInfo.isDirectory() ||
        cwdInfo.isSymbolicLink() ||
        (await realpath(request.cwd)) !== request.cwd
      )
        throw new TerminalError(
          "TERMINAL_CWD_INVALID",
          "Canonical trusted project root required.",
          409,
        );
      request.signal.throwIfAborted();
      // eslint-disable-next-line prefer-const -- Startup callbacks need an undefined-safe transport until asynchronous launcher registration completes.
      let transport: TerminalJobTransport | undefined;
      let nativeReady = false;
      let workerReady = false;
      let ready = false;
      let stopped = false;
      let resolveReady!: () => void;
      let rejectReady!: (error: Error) => void;
      const start = new Promise<void>((resolve, reject) => {
        resolveReady = resolve;
        rejectReady = reject;
      });
      const acks = new Map<
        number,
        {
          resolve: () => void;
          reject: (error: Error) => void;
          timer: ReturnType<typeof setTimeout>;
        }
      >();
      let sequence = 0;
      const fail = () => {
        rejectReady(new Error("Human ConPTY worker failed."));
        for (const a of acks.values()) {
          clearTimeout(a.timer);
          a.reject(new Error("Human terminal worker unavailable."));
        }
        acks.clear();
        void transport?.terminate().catch(() => {
          request.output("terminal", "[Terminal cleanup could not be confirmed.]\r\n");
        });
      };
      const sendLaunch = () => {
        if (nativeReady && workerReady && !ready && transport) {
          workerReady = false;
          void transport
            .send({
              kind: "launch",
              cwd: grant.cwd,
              shell: grant.shell,
              nonce: grant.nonce,
              expiresAt: grant.expiresAt,
              cols: request.cols,
              rows: request.rows,
            })
            .catch(fail);
        }
      };
      transport = await launchTerminalJob({
        windowsIdentity: authority.windowsIdentity,
        onMessage: (value) => {
          if (!value || typeof value !== "object") {
            fail();
            return;
          }
          const message = value as Record<string, unknown>;
          const exact = (keys: string[]) =>
            Object.keys(message).length === keys.length &&
            keys.every((key) => Object.hasOwn(message, key));
          if (message.kind === "native-ready") {
            if (
              !exact(["kind", "windowsIdentity"]) ||
              message.windowsIdentity !== authority.windowsIdentity
            ) {
              fail();
              return;
            }
            nativeReady = true;
            sendLaunch();
          } else if (message.kind === "worker-ready") {
            if (!exact(["kind"])) {
              fail();
              return;
            }
            workerReady = true;
            sendLaunch();
          } else if (message.kind === "ready") {
            if (
              !nativeReady ||
              !exact(["kind", "cols", "rows", "pid"]) ||
              message.cols !== request.cols ||
              message.rows !== request.rows ||
              !Number.isSafeInteger(message.pid) ||
              Number(message.pid) < 1
            ) {
              fail();
              return;
            }
            ready = true;
            resolveReady();
          } else if (message.kind === "output") {
            if (
              !ready ||
              !exact(["kind", "text"]) ||
              typeof message.text !== "string" ||
              message.text.length > 16384
            ) {
              fail();
              return;
            }
            request.output("terminal", message.text);
          } else if (message.kind === "ack") {
            if (
              !exact(["kind", "requestId"]) ||
              !Number.isSafeInteger(message.requestId) ||
              !acks.has(Number(message.requestId))
            ) {
              fail();
              return;
            }
            const ack = acks.get(Number(message.requestId));
            if (ack) {
              clearTimeout(ack.timer);
              ack.resolve();
              acks.delete(Number(message.requestId));
            }
          } else if (message.kind === "exit") {
            if (!exact(["kind", "exitCode"]) || !Number.isSafeInteger(message.exitCode)) {
              fail();
              return;
            }
            request.exit(Number.isSafeInteger(message.exitCode) ? Number(message.exitCode) : null);
          } else fail();
        },
        onExit: (code) => {
          stopped = true;
          request.exit(code);
          if (!ready) rejectReady(new Error("Native human terminal launch failed."));
          for (const ack of acks.values()) {
            clearTimeout(ack.timer);
            ack.reject(new Error("Terminal exited."));
          }
          acks.clear();
        },
      });
      sendLaunch();
      const cancel = () => {
        void transport?.terminate().catch(() => {
          request.output("terminal", "[Terminal cleanup could not be confirmed.]\r\n");
        });
      };
      request.signal.addEventListener("abort", cancel, { once: true });
      if (request.signal.aborted) cancel();
      const launchTimer = setTimeout(() => {
        rejectReady(new Error("ConPTY startup timed out."));
        cancel();
      }, 60000);
      try {
        await start;
      } catch (error) {
        await transport.terminate();
        throw error;
      } finally {
        clearTimeout(launchTimer);
      }
      const operation = (kind: string, fields: Record<string, unknown> = {}) => {
        if (stopped || request.signal.aborted || Date.now() >= grant.expiresAt)
          return Promise.reject(new Error("Human terminal grant unavailable."));
        const id = ++sequence;
        return new Promise<void>((resolve, reject) => {
          const timer = setTimeout(() => {
            acks.delete(id);
            reject(new Error("Terminal operation timed out."));
            cancel();
          }, 5000);
          acks.set(id, { resolve, reject, timer });
          void transport.send({ kind, requestId: id, nonce: grant.nonce, ...fields }).catch(() => {
            clearTimeout(timer);
            acks.delete(id);
            reject(new Error("Terminal transport failed."));
            cancel();
          });
        });
      };
      return {
        input: (text) => operation("input", { text }),
        resize: (cols, rows) => operation("resize", { cols, rows }),
        interrupt: () => operation("interrupt"),
        async close() {
          if (!stopped) await transport.terminate();
          request.signal.removeEventListener("abort", cancel);
        },
      };
    },
  };
}

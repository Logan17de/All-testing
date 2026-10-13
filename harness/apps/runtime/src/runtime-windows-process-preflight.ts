import { randomUUID } from "node:crypto";
import { lstat, mkdtemp, realpath, rm } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";

export interface WindowsDiagnosticInvocation {
  readonly runId: string;
  readonly logicalEffectId: string;
  readonly command: "node-version";
  readonly cwd: string;
}
export interface WindowsDiagnosticReceipt {
  readonly kind: "windows-node-version-preflight";
  readonly profile: string;
  readonly temporary: string;
  readonly bridgePath: string;
  readonly workspace: string;
  readonly runner: string;
  readonly copiedExecutable: string;
  readonly sourceExecutable: string;
  readonly invocation: Readonly<WindowsDiagnosticInvocation>;
}
interface Reservation {
  readonly receipt: WindowsDiagnosticReceipt;
  readonly signal: AbortSignal;
  readonly onAbort: () => void;
  state: "reserved" | "claimed" | "released";
  cleanup?: Promise<void>;
}
const invalid = () => new Error("Windows diagnostic preflight receipt unavailable or mismatched.");
async function canonicalDirectory(path: string): Promise<string> {
  const value = resolve(path);
  const info = await lstat(value);
  if (!info.isDirectory() || info.isSymbolicLink() || (await realpath(value)) !== value)
    throw invalid();
  return value;
}
function invocationValid(value: WindowsDiagnosticInvocation): boolean {
  return (
    Object.keys(value).sort().join(",") === "command,cwd,logicalEffectId,runId" &&
    value.command === "node-version" &&
    [value.runId, value.logicalEffectId].every(
      (id) =>
        typeof id === "string" && id.length > 0 && id.length <= 256 && !/[\x00-\x1f]/u.test(id),
    )
  );
}

/** Host-owned reservation only. No native bridge, profile, ACL, process, or execution authority. */
export async function createWindowsDiagnosticPreflights(reservationRoot: string) {
  const root = await canonicalDirectory(reservationRoot);
  if (dirname(root) === root) throw invalid();
  const reservations = new WeakMap<WindowsDiagnosticReceipt, Reservation>();
  const active = new Set<Reservation>();
  let closed = false;
  async function cleanup(reservation: Reservation): Promise<void> {
    if (reservation.cleanup) return reservation.cleanup;
    reservation.state = "released";
    reservation.signal.removeEventListener("abort", reservation.onAbort);
    active.delete(reservation);
    reservation.cleanup = (async () => {
      const target = reservation.receipt.temporary;
      await canonicalDirectory(root);
      // Delete only the exact generated direct child of the host-owned canonical root.
      if (dirname(target) !== root || !basename(target).startsWith("zet-win-process-"))
        throw invalid();
      const info = await lstat(target).catch((error: NodeJS.ErrnoException) => {
        if (error.code === "ENOENT") return undefined;
        throw error;
      });
      if (!info) return;
      if (!info.isDirectory() || info.isSymbolicLink() || (await realpath(target)) !== target)
        throw invalid();
      await rm(target, { recursive: true, force: true });
    })();
    return reservation.cleanup;
  }
  function lookup(receipt: WindowsDiagnosticReceipt): Reservation {
    const value = reservations.get(receipt);
    if (!value) throw invalid();
    return value;
  }
  return Object.freeze({
    async reserve(invocation: WindowsDiagnosticInvocation, signal: AbortSignal) {
      signal.throwIfAborted();
      if (closed) throw invalid();
      if (!invocationValid(invocation)) throw invalid();
      const bound = Object.freeze({ ...invocation, cwd: await canonicalDirectory(invocation.cwd) });
      if (bound.cwd !== invocation.cwd) throw invalid();
      const sourceExecutable = await realpath(process.execPath);
      // Recheck the host's root before reserving; callers cannot choose profile or descendant paths.
      if ((await canonicalDirectory(root)) !== root) throw invalid();
      const temporary = await mkdtemp(join(root, "zet-win-process-"));
      const receipt: WindowsDiagnosticReceipt = Object.freeze({
        kind: "windows-node-version-preflight",
        profile: `zet-harness-${randomUUID()}`,
        temporary,
        bridgePath: join(temporary, "bridge.ps1"),
        workspace: join(temporary, "workspace"),
        runner: join(temporary, "runner"),
        copiedExecutable: join(temporary, "runner", "node.exe"),
        sourceExecutable,
        invocation: bound,
      });
      const reservation: Reservation = {
        receipt,
        signal,
        state: "reserved",
        onAbort: () => {
          void cleanup(reservation).catch(() => undefined);
        },
      };
      reservations.set(receipt, reservation);
      active.add(reservation);
      signal.addEventListener("abort", reservation.onAbort, { once: true });
      if (closed || signal.aborted) {
        await cleanup(reservation);
        if (closed) throw invalid();
        signal.throwIfAborted();
      }
      return receipt;
    },
    /** One-shot validation only; deliberately grants no Windows execution permission. */
    claim(receipt: WindowsDiagnosticReceipt, invocation: WindowsDiagnosticInvocation) {
      const reservation = lookup(receipt);
      if (
        reservation.state !== "reserved" ||
        reservation.signal.aborted ||
        !invocationValid(invocation)
      )
        throw invalid();
      if (
        ["runId", "logicalEffectId", "command", "cwd"].some(
          (key) =>
            invocation[key as keyof WindowsDiagnosticInvocation] !==
            receipt.invocation[key as keyof WindowsDiagnosticInvocation],
        )
      )
        throw invalid();
      reservation.state = "claimed";
      return receipt;
    },
    release(receipt: WindowsDiagnosticReceipt) {
      return cleanup(lookup(receipt));
    },
    async close() {
      closed = true;
      await Promise.all([...active].map(cleanup));
    },
  });
}

import type { ChildProcess, SpawnOptions } from "node:child_process";

export function treeSpawnOptions(): SpawnOptions;
export function stopProcessTree(
  child: ChildProcess,
  options?: { readonly force?: boolean },
): Promise<void>;
export function stopProcessId(
  pid: number,
  options?: { readonly force?: boolean; readonly fallback?: ChildProcess },
): Promise<void>;
export function portInUse(port: number, host?: string, timeoutMs?: number): Promise<boolean>;
export function listeningProcessId(port: number): Promise<number | undefined>;

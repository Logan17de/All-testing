import { randomUUID } from "node:crypto";
import { isAbsolute } from "node:path";
import type { ModelImagePart } from "@zet-harness/plugin-api";

export interface CodingImageAuthority {
  readonly runId: string;
  readonly sessionId: string;
  readonly modelId: string;
  /** Opaque identity of the selected credential/account, never credentials. */
  readonly accountId: string | null;
  readonly root: string;
  readonly desktopGeneration: number;
}
interface Lease {
  authority: CodingImageAuthority;
  bytes: Buffer;
  artifactId: string;
  expiresAt: number;
  remaining: number;
  timer: ReturnType<typeof setTimeout>;
}
const fields = ["runId", "sessionId", "modelId", "accountId", "root", "desktopGeneration"] as const;
function validate(authority: CodingImageAuthority): void {
  if (
    !authority ||
    Object.keys(authority).some((key) => !fields.includes(key as (typeof fields)[number])) ||
    ![authority.runId, authority.sessionId, authority.modelId].every(
      (value) =>
        typeof value === "string" &&
        value.length > 0 &&
        Buffer.byteLength(value) <= 200 &&
        !/[\x00-\x1f\x7f]/.test(value),
    ) ||
    !(
      authority.accountId === null ||
      (typeof authority.accountId === "string" &&
        authority.accountId.length > 0 &&
        authority.accountId.length <= 200)
    ) ||
    typeof authority.root !== "string" ||
    !isAbsolute(authority.root) ||
    authority.root.length > 4096 ||
    !Number.isSafeInteger(authority.desktopGeneration) ||
    authority.desktopGeneration < 0
  )
    throw new Error("Invalid image authority.");
}
function same(left: CodingImageAuthority, right: CodingImageAuthority): boolean {
  return fields.every((key) => left[key] === right[key]);
}
function png(bytes: Buffer): void {
  if (
    bytes.length < 33 ||
    bytes.length > 8_388_608 ||
    !bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])) ||
    bytes.readUInt32BE(8) !== 13 ||
    bytes.subarray(12, 16).toString("ascii") !== "IHDR"
  )
    throw new Error("Unsupported bounded screenshot.");
  const width = bytes.readUInt32BE(16),
    height = bytes.readUInt32BE(20);
  if (width < 1 || height < 1 || width > 16384 || height > 16384 || width * height > 33_554_432)
    throw new Error("Screenshot dimensions exceed limits.");
}
/** Private volatile pixels. Only opaque references may enter durable agent records. */
export class RuntimeCodingImageStore {
  #leases = new Map<string, Lease>();
  #bytes = 0;
  constructor(
    readonly options: {
      isCurrent: (authority: CodingImageAuthority) => boolean;
      now?: () => number;
    },
  ) {}
  #now() {
    return this.options.now?.() ?? Date.now();
  }
  #remove(ref: string) {
    const lease = this.#leases.get(ref);
    if (!lease) return;
    clearTimeout(lease.timer);
    this.#bytes -= lease.bytes.length;
    lease.bytes.fill(0);
    this.#leases.delete(ref);
  }
  #current(authority: CodingImageAuthority) {
    try {
      return this.options.isCurrent(authority);
    } catch {
      return false;
    }
  }
  authorized(authority: CodingImageAuthority): boolean {
    try {
      validate(authority);
      return this.#current(authority);
    } catch {
      return false;
    }
  }
  createApprovedLease(input: {
    authority: CodingImageAuthority;
    bytes: Buffer;
    artifactId: string;
    expiresAt: number;
    maxUses: number;
    approved: true;
  }): ModelImagePart {
    validate(input.authority);
    png(input.bytes);
    if (
      input.approved !== true ||
      !/^[0-9a-f-]{36}$/.test(input.artifactId) ||
      !Number.isSafeInteger(input.expiresAt) ||
      input.expiresAt <= this.#now() ||
      input.expiresAt > this.#now() + 120_000 ||
      !Number.isInteger(input.maxUses) ||
      input.maxUses < 1 ||
      input.maxUses > 8 ||
      !this.#current(input.authority)
    )
      throw new Error("Current scoped image consent required.");
    this.#sweep();
    this.revokeRun(input.authority.runId);
    if (this.#leases.size >= 20 || this.#bytes + input.bytes.length > 33_554_432)
      throw new Error("Volatile screenshot budget exceeded.");
    const ref = `artifact:${randomUUID()}`;
    const authority = Object.freeze({ ...input.authority });
    const bytes = Buffer.from(input.bytes);
    const timer = setTimeout(() => this.#remove(ref), input.expiresAt - this.#now());
    timer.unref();
    this.#leases.set(ref, {
      authority,
      bytes,
      artifactId: input.artifactId,
      expiresAt: input.expiresAt,
      remaining: input.maxUses,
      timer,
    });
    this.#bytes += bytes.length;
    return Object.freeze({ kind: "image", artifactRef: ref, mediaType: "image/png" });
  }
  #sweep() {
    for (const [ref, lease] of this.#leases)
      if (lease.expiresAt <= this.#now() || !this.#current(lease.authority)) this.#remove(ref);
  }
  partsFor(authority: CodingImageAuthority): readonly ModelImagePart[] {
    validate(authority);
    this.#sweep();
    if (!this.#current(authority)) return [];
    return Object.freeze(
      [...this.#leases].flatMap(([ref, lease]) =>
        same(lease.authority, authority) && lease.remaining > 0
          ? [Object.freeze({ kind: "image" as const, artifactRef: ref, mediaType: "image/png" })]
          : [],
      ),
    );
  }
  resolve(ref: string, authority: CodingImageAuthority, signal: AbortSignal): Promise<Uint8Array> {
    try {
      signal.throwIfAborted();
      validate(authority);
      this.#sweep();
      const lease = this.#leases.get(ref);
      if (
        !lease ||
        !same(lease.authority, authority) ||
        !this.#current(authority) ||
        lease.remaining < 1
      )
        throw new Error("Screenshot lease expired or outside current turn.");
      const bytes = Buffer.from(lease.bytes);
      if (signal.aborted || !this.#current(authority)) {
        bytes.fill(0);
        throw new Error("Screenshot lease expired or outside current turn.");
      }
      lease.remaining--;
      if (lease.remaining === 0) this.#remove(ref);
      return Promise.resolve(bytes);
    } catch {
      return Promise.reject(new Error("Screenshot lease unavailable for this invocation."));
    }
  }
  revokeRun(runId: string) {
    for (const [ref, lease] of this.#leases) if (lease.authority.runId === runId) this.#remove(ref);
  }
  clear() {
    for (const ref of this.#leases.keys()) this.#remove(ref);
  }
}

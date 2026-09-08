import { createHash, randomUUID } from "node:crypto";
import { mkdir, open, readFile, rm, link, type FileHandle } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";

export const CONTENT_ADDRESSED_BLOB_ALGORITHM = "sha256" as const;
export const CONTENT_ADDRESSED_BLOB_ID_PREFIX = `${CONTENT_ADDRESSED_BLOB_ALGORITHM}:` as const;

const CONTENT_ADDRESSED_BLOB_ID_PATTERN = /^sha256:([0-9a-f]{64})$/;
const VERIFY_BUFFER_BYTES = 64 * 1024;

export type ContentAddressedBlobId = `sha256:${string}`;

export interface ContentAddressedBlobRef {
  readonly blobId: ContentAddressedBlobId;
  readonly sizeBytes: number;
}

export interface FileContentAddressedBlobStoreOptions {
  readonly rootPath: string;
}

export interface FileContentAddressedBlobStoreSnapshot {
  readonly rootPath: string;
  readonly algorithm: typeof CONTENT_ADDRESSED_BLOB_ALGORITHM;
}

export class ContentAddressedBlobIntegrityError extends Error {
  readonly code = "CONTENT_ADDRESSED_BLOB_INTEGRITY_MISMATCH" as const;

  constructor(
    readonly blobId: ContentAddressedBlobId,
    message: string,
  ) {
    super(message);
    this.name = "ContentAddressedBlobIntegrityError";
  }
}

interface NormalizedBlobLookup {
  readonly blobId: ContentAddressedBlobId;
  readonly digest: string;
  readonly expectedSizeBytes: number | undefined;
}

function isErrorCode(error: unknown, code: string): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error as { readonly code?: unknown }).code === code
  );
}

function parseBlobId(blobId: ContentAddressedBlobId): {
  readonly blobId: ContentAddressedBlobId;
  readonly digest: string;
} {
  const match = CONTENT_ADDRESSED_BLOB_ID_PATTERN.exec(blobId);
  const digest = match?.[1];
  if (digest === undefined) {
    throw new TypeError(
      "Content-addressed blob ID must use canonical 'sha256:<64 lowercase hex>' form.",
    );
  }

  return Object.freeze({ blobId, digest });
}

function assertSizeBytes(sizeBytes: number): void {
  if (!Number.isSafeInteger(sizeBytes) || sizeBytes < 0) {
    throw new TypeError("Content-addressed blob sizeBytes must be a non-negative safe integer.");
  }
}

function createBlobRef(digest: string, sizeBytes: number): ContentAddressedBlobRef {
  assertSizeBytes(sizeBytes);
  return Object.freeze({
    blobId: `${CONTENT_ADDRESSED_BLOB_ID_PREFIX}${digest}`,
    sizeBytes,
  });
}

function normalizeBlobLookup(
  refOrId: ContentAddressedBlobRef | ContentAddressedBlobId,
): NormalizedBlobLookup {
  if (typeof refOrId === "string") {
    const parsed = parseBlobId(refOrId);
    return Object.freeze({ ...parsed, expectedSizeBytes: undefined });
  }

  const parsed = parseBlobId(refOrId.blobId);
  assertSizeBytes(refOrId.sizeBytes);
  return Object.freeze({ ...parsed, expectedSizeBytes: refOrId.sizeBytes });
}

async function writeAll(handle: FileHandle, bytes: Uint8Array): Promise<void> {
  let offset = 0;
  while (offset < bytes.byteLength) {
    const { bytesWritten } = await handle.write(bytes, offset, bytes.byteLength - offset, null);
    if (bytesWritten <= 0) {
      throw new TypeError("Blob temp-file write made no forward progress.");
    }
    offset += bytesWritten;
  }
}

/**
 * Filesystem content-addressed storage for large immutable values.
 *
 * Blobs are addressed only by SHA-256 content identity and published beneath
 * `<root>/sha256/<first-two-hex>/<remaining-hex>`. Streaming writes hash while
 * writing a private temp file, fsync that complete file, then publish it with an
 * atomic no-overwrite hard link. Concurrent writers of identical bytes converge
 * on one final path. Existing content is verified before reuse and is never
 * silently repaired or overwritten when corruption is detected.
 *
 * This store owns immutable bytes only. SQLite output references, node-completion
 * transactions, retention/GC, and backup orchestration remain later Phase 4 work.
 */
export class FileContentAddressedBlobStore {
  private readonly rootPath: string;

  constructor(options: FileContentAddressedBlobStoreOptions) {
    if (options.rootPath.trim().length === 0) {
      throw new TypeError("Content-addressed blob root path must not be empty.");
    }
    this.rootPath = resolve(options.rootPath);
  }

  snapshot(): FileContentAddressedBlobStoreSnapshot {
    return Object.freeze({
      rootPath: this.rootPath,
      algorithm: CONTENT_ADDRESSED_BLOB_ALGORITHM,
    });
  }

  async putBytes(data: Uint8Array): Promise<ContentAddressedBlobRef> {
    if (!(data instanceof Uint8Array)) {
      throw new TypeError("Content-addressed blob bytes must be a Uint8Array.");
    }
    return this.putStream([data]);
  }

  async putStream(
    chunks: AsyncIterable<Uint8Array> | Iterable<Uint8Array>,
  ): Promise<ContentAddressedBlobRef> {
    await mkdir(this.rootPath, { recursive: true });

    const tempPath = join(this.rootPath, `.tmp-${String(process.pid)}-${randomUUID()}`);
    const hash = createHash(CONTENT_ADDRESSED_BLOB_ALGORITHM);
    let sizeBytes = 0;
    let handle: FileHandle | undefined;

    try {
      handle = await open(tempPath, "wx", 0o600);

      for await (const chunk of chunks) {
        if (!(chunk instanceof Uint8Array)) {
          throw new TypeError("Content-addressed blob stream chunks must be Uint8Array values.");
        }

        const stableBytes = Buffer.from(chunk);
        if (sizeBytes > Number.MAX_SAFE_INTEGER - stableBytes.byteLength) {
          throw new RangeError("Content-addressed blob size exceeded the safe integer range.");
        }

        hash.update(stableBytes);
        await writeAll(handle, stableBytes);
        sizeBytes += stableBytes.byteLength;
      }

      await handle.sync();
      await handle.close();
      handle = undefined;

      const digest = hash.digest("hex");
      const ref = createBlobRef(digest, sizeBytes);
      const finalPath = this.pathForDigest(digest);
      await mkdir(dirname(finalPath), { recursive: true });

      if (await this.tryVerifyExisting(finalPath, ref)) {
        return ref;
      }

      try {
        await link(tempPath, finalPath);
      } catch (error) {
        if (!isErrorCode(error, "EEXIST")) {
          throw error;
        }
        await this.verifyBlobPath(finalPath, ref);
      }

      return ref;
    } finally {
      if (handle !== undefined) {
        await handle.close().catch(() => undefined);
      }
      await rm(tempPath, { force: true }).catch(() => undefined);
    }
  }

  async verify(
    refOrId: ContentAddressedBlobRef | ContentAddressedBlobId,
  ): Promise<ContentAddressedBlobRef> {
    const lookup = normalizeBlobLookup(refOrId);
    return this.verifyBlobPath(this.pathForDigest(lookup.digest), lookup);
  }

  async readBytes(
    refOrId: ContentAddressedBlobRef | ContentAddressedBlobId,
  ): Promise<Uint8Array> {
    const lookup = normalizeBlobLookup(refOrId);
    const bytes = await readFile(this.pathForDigest(lookup.digest));
    const actualDigest = createHash(CONTENT_ADDRESSED_BLOB_ALGORITHM).update(bytes).digest("hex");

    this.assertIntegrity(lookup, actualDigest, bytes.byteLength);
    return bytes;
  }

  private pathForDigest(digest: string): string {
    return join(
      this.rootPath,
      CONTENT_ADDRESSED_BLOB_ALGORITHM,
      digest.slice(0, 2),
      digest.slice(2),
    );
  }

  private async tryVerifyExisting(
    path: string,
    lookup: ContentAddressedBlobRef | NormalizedBlobLookup,
  ): Promise<boolean> {
    try {
      await this.verifyBlobPath(path, lookup);
      return true;
    } catch (error) {
      if (isErrorCode(error, "ENOENT")) {
        return false;
      }
      throw error;
    }
  }

  private async verifyBlobPath(
    path: string,
    lookupInput: ContentAddressedBlobRef | NormalizedBlobLookup,
  ): Promise<ContentAddressedBlobRef> {
    const lookup = "digest" in lookupInput ? lookupInput : normalizeBlobLookup(lookupInput);
    const handle = await open(path, "r");
    const hash = createHash(CONTENT_ADDRESSED_BLOB_ALGORITHM);
    const buffer = Buffer.allocUnsafe(VERIFY_BUFFER_BYTES);
    let sizeBytes = 0;

    try {
      const stats = await handle.stat();
      if (!stats.isFile()) {
        throw new ContentAddressedBlobIntegrityError(
          lookup.blobId,
          `Content-addressed blob '${lookup.blobId}' is not a regular file.`,
        );
      }

      while (true) {
        const { bytesRead } = await handle.read(buffer, 0, buffer.byteLength, null);
        if (bytesRead === 0) {
          break;
        }
        if (sizeBytes > Number.MAX_SAFE_INTEGER - bytesRead) {
          throw new RangeError("Content-addressed blob size exceeded the safe integer range.");
        }
        hash.update(buffer.subarray(0, bytesRead));
        sizeBytes += bytesRead;
      }
    } finally {
      await handle.close();
    }

    const actualDigest = hash.digest("hex");
    this.assertIntegrity(lookup, actualDigest, sizeBytes);
    return createBlobRef(actualDigest, sizeBytes);
  }

  private assertIntegrity(
    lookup: NormalizedBlobLookup,
    actualDigest: string,
    actualSizeBytes: number,
  ): void {
    if (actualDigest !== lookup.digest) {
      throw new ContentAddressedBlobIntegrityError(
        lookup.blobId,
        `Content-addressed blob '${lookup.blobId}' failed SHA-256 verification.`,
      );
    }

    if (
      lookup.expectedSizeBytes !== undefined &&
      actualSizeBytes !== lookup.expectedSizeBytes
    ) {
      throw new ContentAddressedBlobIntegrityError(
        lookup.blobId,
        `Content-addressed blob '${lookup.blobId}' size ${String(actualSizeBytes)} does not match expected ${String(lookup.expectedSizeBytes)}.`,
      );
    }
  }
}

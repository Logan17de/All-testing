import { createHash } from "node:crypto";
import { mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import {
  CONTENT_ADDRESSED_BLOB_ALGORITHM,
  ContentAddressedBlobIntegrityError,
  FileContentAddressedBlobStore,
  type ContentAddressedBlobId,
} from "./content-addressed-blob-store.js";

const createRoot = async (): Promise<string> => mkdtemp(join(tmpdir(), "zet-harness-blob-store-"));

const digestOf = (bytes: Uint8Array): string =>
  createHash(CONTENT_ADDRESSED_BLOB_ALGORITHM).update(bytes).digest("hex");

const pathFor = (root: string, blobId: ContentAddressedBlobId): string => {
  const digest = blobId.slice("sha256:".length);
  return join(root, "sha256", digest.slice(0, 2), digest.slice(2));
};

const withStore = async (
  run: (store: FileContentAddressedBlobStore, root: string) => Promise<void>,
): Promise<void> => {
  const root = await createRoot();
  const store = new FileContentAddressedBlobStore({ rootPath: root });

  try {
    await run(store, root);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
};

describe("FileContentAddressedBlobStore", () => {
  it("uses canonical SHA-256 IDs and the sharded immutable filesystem layout", async () => {
    await withStore(async (store, root) => {
      const bytes = Buffer.from("hello");
      const digest = "2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824";

      expect(store.snapshot()).toEqual({
        rootPath: root,
        algorithm: "sha256",
      });

      const ref = await store.putBytes(bytes);
      expect(ref).toEqual({ blobId: `sha256:${digest}`, sizeBytes: 5 });
      expect(await readFile(pathFor(root, ref.blobId))).toEqual(bytes);
      expect(await store.readBytes(ref)).toEqual(bytes);
      expect(await store.verify(ref)).toEqual(ref);
    });
  });

  it("hashes streaming chunks incrementally and supports the empty blob", async () => {
    await withStore(async (store) => {
      function* content(): Generator<Uint8Array> {
        yield Buffer.from("stream-");
        yield Buffer.from("value");
      }

      const streamed = await store.putStream(content());
      const expectedBytes = Buffer.from("stream-value");
      expect(streamed).toEqual({
        blobId: `sha256:${digestOf(expectedBytes)}`,
        sizeBytes: expectedBytes.byteLength,
      });
      expect(await store.readBytes(streamed.blobId)).toEqual(expectedBytes);

      const empty = await store.putStream([]);
      expect(empty).toEqual({
        blobId: "sha256:e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
        sizeBytes: 0,
      });
    });
  });

  it("deduplicates concurrent identical writers without exposing a partial final blob", async () => {
    await withStore(async (store, root) => {
      const bytes = Buffer.from("same immutable payload");
      const refs = await Promise.all(Array.from({ length: 12 }, async () => store.putBytes(bytes)));

      expect(new Set(refs.map((ref) => ref.blobId)).size).toBe(1);
      expect(new Set(refs.map((ref) => ref.sizeBytes))).toEqual(new Set([bytes.byteLength]));

      const first = refs[0];
      if (first === undefined) {
        throw new TypeError("Concurrent blob test produced no references.");
      }
      expect(await readFile(pathFor(root, first.blobId))).toEqual(bytes);
      expect((await readdir(root)).some((name) => name.startsWith(".tmp-"))).toBe(false);
    });
  });

  it("keeps different content at different immutable addresses", async () => {
    await withStore(async (store) => {
      const left = await store.putBytes(Buffer.from("left"));
      const right = await store.putBytes(Buffer.from("right"));

      expect(left.blobId).not.toBe(right.blobId);
      expect(await store.readBytes(left)).toEqual(Buffer.from("left"));
      expect(await store.readBytes(right)).toEqual(Buffer.from("right"));
    });
  });

  it("detects corrupted content and mismatched reference size instead of repairing silently", async () => {
    await withStore(async (store, root) => {
      const original = Buffer.from("original");
      const ref = await store.putBytes(original);
      const blobPath = pathFor(root, ref.blobId);

      await expect(
        store.verify({ blobId: ref.blobId, sizeBytes: ref.sizeBytes + 1 }),
      ).rejects.toBeInstanceOf(ContentAddressedBlobIntegrityError);

      await writeFile(blobPath, Buffer.from("tampered"));

      await expect(store.readBytes(ref.blobId)).rejects.toMatchObject({
        name: "ContentAddressedBlobIntegrityError",
        code: "CONTENT_ADDRESSED_BLOB_INTEGRITY_MISMATCH",
        blobId: ref.blobId,
      });
      await expect(store.putBytes(original)).rejects.toBeInstanceOf(
        ContentAddressedBlobIntegrityError,
      );
      expect(await readFile(blobPath)).toEqual(Buffer.from("tampered"));
    });
  });

  it("rejects malformed IDs and invalid reference sizes before path resolution", async () => {
    await withStore(async (store) => {
      await expect(store.readBytes("sha256:../../escape")).rejects.toThrow(TypeError);
      await expect(
        store.verify({
          blobId: "sha256:2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824",
          sizeBytes: -1,
        }),
      ).rejects.toThrow(TypeError);
    });
  });

  it("removes private temp files when a streaming producer fails", async () => {
    await withStore(async (store, root) => {
      function* broken(): Generator<Uint8Array> {
        yield Buffer.from("partial");
        throw new TypeError("producer failed");
      }

      await expect(store.putStream(broken())).rejects.toThrow("producer failed");
      expect((await readdir(root)).some((name) => name.startsWith(".tmp-"))).toBe(false);
      expect(await readdir(root)).toEqual([]);
    });
  });

  it("rejects an empty root path", () => {
    expect(() => new FileContentAddressedBlobStore({ rootPath: "   " })).toThrow(TypeError);
  });
});

import {
  link,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rename,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it, vi } from "vitest";
import {
  executeWindowsCodingBatch,
  executeWindowsCodingOperation,
  validateWindowsCodingBridge,
  WINDOWS_CODING_SCRIPT,
  type WindowsCodingRequest,
  type WindowsCodingRunner,
} from "./runtime-windows-coding.js";
const signal = () => new AbortController().signal;
it("fails closed on non-Windows without starting a host bridge", async () => {
  if (process.platform === "win32") return;
  await expect(validateWindowsCodingBridge(signal())).rejects.toThrow("unavailable");
  await expect(
    executeWindowsCodingOperation(
      { operation: "read", root: "C:\\workspace", path: "file.ts" },
      signal(),
    ),
  ).rejects.toThrow("unavailable");
});
it("copies bounded requests before awaiting the injected bridge (mock)", async () => {
  const requests: WindowsCodingRequest[] = [
    {
      operation: "write",
      root: "C:\\workspace",
      path: "file.ts",
      expectedContent: "before",
      content: "after",
    },
  ];
  const runner = vi.fn<WindowsCodingRunner>((input) => {
    requests[0] = {
      operation: "delete",
      root: "C:\\other",
      path: "private",
      expectedContent: "changed",
    };
    expect(JSON.parse(input)).toEqual({
      requests: [
        {
          operation: "write",
          root: "C:\\workspace",
          path: "file.ts",
          expectedContent: "before",
          content: "after",
        },
      ],
    });
    return Promise.resolve('{"results":[{"success":true,"value":{"writtenBytes":5}}]}');
  });
  expect(await executeWindowsCodingBatch(requests, signal(), runner)).toEqual([
    { success: true, value: { writtenBytes: 5 } },
  ]);
});
it("rejects credential/escape/ADS/device/alias paths before any bridge execution", async () => {
  const runner = vi.fn<WindowsCodingRunner>(() => Promise.resolve('{"results":[]}'));
  for (const path of [
    "../outside",
    ".env",
    ".git/config",
    "a:b",
    "C:drive-relative",
    "CON.txt",
    "trailing.",
    "short~1/file",
    "a\\b",
    "password.txt",
  ])
    await expect(
      executeWindowsCodingBatch(
        [{ operation: "read", root: "C:\\workspace", path }],
        signal(),
        runner,
      ),
    ).rejects.toThrow("rejected");
  expect(runner).not.toHaveBeenCalled();
});
it("requires exact bounded expected content and rejects extra request fields", async () => {
  const runner = vi.fn<WindowsCodingRunner>(() => Promise.resolve('{"results":[]}'));
  for (const request of [
    { operation: "write", path: "file", content: "x" },
    { operation: "delete", path: "file" },
    { operation: "write", path: "file", expectedContent: null, content: "\ud800" },
    { operation: "rename", path: "file", to: "other", expectedContent: null },
    { operation: "write", path: "file", expectedContent: null, content: "x".repeat(65537) },
    { operation: "read", path: "file", command: "arbitrary" },
  ])
    await expect(
      executeWindowsCodingBatch(
        [{ root: "C:\\workspace", ...request } as WindowsCodingRequest],
        signal(),
        runner,
      ),
    ).rejects.toThrow("rejected");
  expect(runner).not.toHaveBeenCalled();
});
it("keeps file contents outside failures and discards cancelled results", async () => {
  const secret = "fixture-content-never-in-error";
  const runner = vi.fn<WindowsCodingRunner>(() => Promise.reject(new Error(secret)));
  const request: WindowsCodingRequest = {
    operation: "write",
    root: "C:\\workspace",
    path: "file",
    expectedContent: null,
    content: secret,
  };
  const error: unknown = await executeWindowsCodingBatch([request], signal(), runner).catch(
    (error: unknown) => error,
  );
  expect((error as Error).message).not.toContain(secret);
  const controller = new AbortController();
  const late: WindowsCodingRunner = () => {
    controller.abort();
    return Promise.resolve('{"results":[{"success":true}]}');
  };
  await expect(executeWindowsCodingBatch([request], controller.signal, late)).rejects.toThrow();
});
it("keeps fixed source below Windows command-line bounds and compile validation before all filesystem calls", () => {
  expect(Buffer.from(WINDOWS_CODING_SCRIPT, "utf16le").toString("base64").length).toBeLessThan(
    31000,
  );
  expect(WINDOWS_CODING_SCRIPT.indexOf("if ($data.operation -eq 'validate')")).toBeLessThan(
    WINDOWS_CODING_SCRIPT.indexOf("foreach ($request in $data.requests)"),
  );
  expect(WINDOWS_CODING_SCRIPT).toContain("CreateFileW(value,ATTR,3"); // no FILE_SHARE_DELETE directory ancestry locks
  expect(WINDOWS_CODING_SCRIPT).toContain("CreateFileW(file,access,0"); // exclusive regular-file access
});
it.skipIf(process.platform !== "win32")(
  "compiles the actual fixed Windows bridge without filesystem operations (Windows CI)",
  async () => {
    await expect(validateWindowsCodingBridge(AbortSignal.timeout(70_000))).resolves.toBeUndefined();
  },
  75_000,
);
it.skipIf(process.platform !== "win32")(
  "performs real bounded Windows temporary-workspace operations and rejects links/expected-content mismatches (Windows CI)",
  async () => {
    const directory = await mkdtemp(join(tmpdir(), "zet-windows-files-"));
    const root = join(directory, "workspace");
    const outside = join(directory, "outside");
    await mkdir(root);
    await mkdir(outside);
    await writeFile(join(root, "source.ts"), "alpha\nbeta\n");
    await writeFile(join(root, ".env"), "fixture-private");
    await writeFile(join(root, "occupied.ts"), "occupied");
    await writeFile(join(root, "linked-source"), "linked");
    await link(join(root, "linked-source"), join(root, "hard"));
    await writeFile(join(outside, "outside.ts"), "outside-fixture");
    await symlink(outside, join(root, "junction"), "junction");
    const request = (
      operation: WindowsCodingRequest["operation"],
      path: string,
      extras: Partial<WindowsCodingRequest> = {},
    ): WindowsCodingRequest => ({ operation, root, path, ...extras });
    try {
      const results = await executeWindowsCodingBatch(
        [
          request("read", "source.ts"),
          request("list", "."),
          request("mkdir", "nested"),
          request("write", "nested/new.ts", { expectedContent: null, content: "hello" }),
          request("read", "nested/new.ts"),
          request("write", "source.ts", { expectedContent: "alpha\nbeta\n", content: "gamma" }),
          request("rename", "source.ts", { to: "renamed.ts", expectedContent: "gamma" }),
          request("delete", "renamed.ts", { expectedContent: "gamma" }),
          request("write", "nested/new.ts", { expectedContent: "wrong", content: "bad" }),
          request("rename", "nested/new.ts", { to: "occupied.ts", expectedContent: "hello" }),
          request("delete", "nested/new.ts", { expectedContent: "wrong" }),
          request("read", "hard"),
          request("read", "junction/outside.ts"),
          request("mkdir", "junction/new"),
          request("rename", "nested/new.ts", { to: "junction/renamed", expectedContent: "hello" }),
          request("read", "nested/new.ts"),
        ],
        AbortSignal.timeout(70_000),
      );
      expect(results.map((result) => result.success)).toEqual([
        true,
        true,
        true,
        true,
        true,
        true,
        true,
        true,
        false,
        false,
        false,
        false,
        false,
        false,
        false,
        true,
      ]);
      expect(results[0]?.value).toEqual({ content: "alpha\nbeta\n" });
      expect(results[4]?.value).toEqual({ content: "hello" });
      expect(results[15]?.value).toEqual({ content: "hello" });
      expect(JSON.stringify(results[1]?.value)).not.toContain(".env");
      expect(JSON.stringify(results[1]?.value)).not.toContain("junction");
      expect(await readFile(join(root, "nested", "new.ts"), "utf8")).toBe("hello");
      expect(await readFile(join(root, "occupied.ts"), "utf8")).toBe("occupied");
      expect(await readdir(outside)).toEqual(["outside.ts"]);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  },
  75_000,
);
it.skipIf(process.platform !== "win32")(
  "never reads an outside fixture while an owned parent races with a junction (Windows CI)",
  async () => {
    const directory = await mkdtemp(join(tmpdir(), "zet-windows-race-"));
    const root = join(directory, "workspace");
    const parent = join(root, "parent");
    const parked = join(root, "parked");
    const outside = join(directory, "outside");
    await mkdir(root);
    await mkdir(parent);
    await mkdir(outside);
    await writeFile(join(parent, "file.ts"), "owned");
    await writeFile(join(outside, "file.ts"), "outside-fixture");
    let active = true;
    let busy = false;
    const race = setInterval(() => {
      if (!active || busy) return;
      busy = true;
      void (async () => {
        try {
          await rename(parent, parked);
          await symlink(outside, parent, "junction");
          await rm(parent, { force: true, recursive: true });
          await rename(parked, parent);
        } catch {
        } finally {
          busy = false;
        }
      })();
    }, 5);
    try {
      const results = await executeWindowsCodingBatch(
        Array.from(
          { length: 20 },
          () => ({ operation: "read", root, path: "parent/file.ts" }) as const,
        ),
        AbortSignal.timeout(70_000),
      );
      expect(
        results.every(
          (result) => !result.success || JSON.stringify(result.value) === '{"content":"owned"}',
        ),
      ).toBe(true);
    } finally {
      active = false;
      clearInterval(race);
      while (busy) await new Promise((resolve) => setTimeout(resolve, 5));
      await rm(directory, { recursive: true, force: true });
    }
  },
  75_000,
);

it.skipIf(process.platform !== "win32")(
  "guards exact custom database and missing sidecars in native Windows bridge",
  async () => {
    const root = await mkdtemp(join(tmpdir(), "zet-win-private-"));
    const database = join(root, "chat.sqlite");
    const privatePaths = [database, `${database}-wal`, `${database}-shm`];
    try {
      await writeFile(database, "private fixture");
      await writeFile(`${database}-wal`, "private wal fixture");
      await writeFile(join(root, "public.ts"), "public");
      const results = await executeWindowsCodingBatch(
        [
          { operation: "read", root, path: "CHAT.SQLITE", privatePaths },
          {
            operation: "write",
            root,
            path: "chat.sqlite-shm",
            privatePaths,
            expectedContent: null,
            content: "bad",
          },
          { operation: "mkdir", root, path: "chat.sqlite-shm", privatePaths },
          {
            operation: "rename",
            root,
            path: "public.ts",
            to: "chat.sqlite-shm",
            privatePaths,
            expectedContent: "public",
          },
          {
            operation: "delete",
            root,
            path: "chat.sqlite",
            privatePaths,
            expectedContent: "private fixture",
          },
          { operation: "list", root, path: ".", privatePaths },
          { operation: "read", root, path: "public.ts", privatePaths },
        ],
        AbortSignal.timeout(70000),
      );
      expect(results.map((entry) => entry.success)).toEqual([
        false,
        false,
        false,
        false,
        false,
        true,
        true,
      ]);
      expect(JSON.stringify(results[5]?.value)).not.toContain("chat.sqlite");
      expect(await readFile(database, "utf8")).toBe("private fixture");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  },
  75000,
);

import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve, sep } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  WorkspacePathError,
  createWorkspacePathResolver,
  isWorkspacePathError,
} from "./workspace-path.js";

const ROOT = resolve(sep === "\\" ? "C:\\workspace\\project" : "/workspace/project");

function resolver(options: { caseInsensitive?: boolean } = {}) {
  return createWorkspacePathResolver(
    options.caseInsensitive === undefined
      ? { root: ROOT }
      : { root: ROOT, caseInsensitive: options.caseInsensitive },
  );
}

function denialCode(run: () => unknown): string {
  try {
    run();
  } catch (error: unknown) {
    if (isWorkspacePathError(error)) return error.code;
    throw error;
  }
  throw new Error("Expected the path to be refused.");
}

describe("WorkspacePathResolver construction", () => {
  it("requires an absolute root", () => {
    expect(() => createWorkspacePathResolver({ root: "relative/path" })).toThrow(TypeError);
  });

  it("requires a non-empty root", () => {
    expect(() => createWorkspacePathResolver({ root: "" })).toThrow(TypeError);
  });

  it("rejects a non-positive path limit", () => {
    expect(() => createWorkspacePathResolver({ root: ROOT, maxPathLength: 0 })).toThrow(TypeError);
  });

  it("is frozen so a caller cannot swap the root after construction", () => {
    const instance = resolver();
    expect(Object.isFrozen(instance)).toBe(true);
  });
});

describe("lexical acceptance", () => {
  it("accepts a simple relative path", () => {
    expect(resolver().resolveLexical("src/index.ts")).toBe(join(ROOT, "src", "index.ts"));
  });

  it("accepts the root itself", () => {
    expect(resolver().resolveLexical(".")).toBe(ROOT);
  });

  it("treats backslash and forward slash identically", () => {
    const instance = resolver();
    expect(instance.resolveLexical("src\\index.ts")).toBe(instance.resolveLexical("src/index.ts"));
  });

  it("collapses interior traversal that lands back inside the root", () => {
    expect(resolver().resolveLexical("src/../docs/readme.md")).toBe(
      join(ROOT, "docs", "readme.md"),
    );
  });

  it("accepts an absolute path that is already inside the root", () => {
    const inside = join(ROOT, "src", "index.ts");
    expect(resolver().resolveLexical(inside)).toBe(inside);
  });

  it("ignores redundant separators and current-directory segments", () => {
    expect(resolver().resolveLexical("./src//./index.ts")).toBe(join(ROOT, "src", "index.ts"));
  });
});

describe("traversal containment", () => {
  it("refuses a path that climbs above the root", () => {
    expect(denialCode(() => resolver().resolveLexical("../secrets.txt"))).toBe("escapes-root");
  });

  it("refuses deep traversal", () => {
    expect(denialCode(() => resolver().resolveLexical("a/b/../../../../etc/passwd"))).toBe(
      "escapes-root",
    );
  });

  it("refuses traversal written with backslashes", () => {
    expect(denialCode(() => resolver().resolveLexical("..\\..\\secrets.txt"))).toBe("escapes-root");
  });

  it("refuses an absolute path outside the root", () => {
    const outside = resolve(sep === "\\" ? "C:\\other\\file.txt" : "/other/file.txt");
    expect(denialCode(() => resolver().resolveLexical(outside))).toBe("escapes-root");
  });

  it("refuses a sibling directory that shares the root name prefix", () => {
    // `project-backup` starts with `project` but is not inside it.
    const sibling = `${ROOT}-backup${sep}file.txt`;
    expect(denialCode(() => resolver().resolveLexical(sibling))).toBe("escapes-root");
  });
});

describe("input validation", () => {
  it("refuses an empty path", () => {
    expect(denialCode(() => resolver().resolveLexical(""))).toBe("empty-path");
  });

  it("refuses a non-string path", () => {
    expect(denialCode(() => resolver().resolveLexical(42 as unknown as string))).toBe(
      "invalid-input",
    );
  });

  it("refuses an embedded NUL byte", () => {
    expect(denialCode(() => resolver().resolveLexical("src/index.ts\0.png"))).toBe("embedded-nul");
  });

  it("refuses a path beyond the configured length limit", () => {
    const instance = createWorkspacePathResolver({ root: ROOT, maxPathLength: 16 });
    expect(denialCode(() => instance.resolveLexical("a".repeat(64)))).toBe("path-too-long");
  });

  it("refuses when the resolved path exceeds the limit even if the input did not", () => {
    const instance = createWorkspacePathResolver({
      root: ROOT,
      maxPathLength: ROOT.length + 4,
    });
    expect(denialCode(() => instance.resolveLexical("a".repeat(ROOT.length)))).toBe(
      "path-too-long",
    );
  });
});

describe("Windows containment rules", () => {
  it("refuses a UNC path", () => {
    expect(denialCode(() => resolver().resolveLexical("\\\\server\\share\\file.txt"))).toBe(
      "unc-path",
    );
  });

  it("refuses a forward-slash UNC path", () => {
    expect(denialCode(() => resolver().resolveLexical("//server/share/file.txt"))).toBe("unc-path");
  });

  it("refuses the Win32 device namespace", () => {
    expect(denialCode(() => resolver().resolveLexical("\\\\?\\C:\\Windows\\system32"))).toBe(
      "device-namespace",
    );
  });

  it("refuses the device namespace prefix", () => {
    expect(denialCode(() => resolver().resolveLexical("\\\\.\\PhysicalDrive0"))).toBe(
      "device-namespace",
    );
  });

  it("refuses a drive-relative path", () => {
    expect(denialCode(() => resolver().resolveLexical("C:work\\file.txt"))).toBe("drive-relative");
  });

  it("refuses an alternate data stream", () => {
    expect(denialCode(() => resolver().resolveLexical("notes.txt:hidden"))).toBe(
      "alternate-data-stream",
    );
  });

  it("refuses an alternate data stream on a nested segment", () => {
    expect(denialCode(() => resolver().resolveLexical("src/notes.txt:$DATA"))).toBe(
      "alternate-data-stream",
    );
  });

  it.each(["CON", "PRN", "AUX", "NUL", "COM1", "LPT9", "CONIN$", "CONOUT$"])(
    "refuses the reserved device name %s",
    (name) => {
      expect(denialCode(() => resolver().resolveLexical(`src/${name}`))).toBe(
        "reserved-device-name",
      );
    },
  );

  it("refuses a reserved device name carrying an extension", () => {
    expect(denialCode(() => resolver().resolveLexical("CON.txt"))).toBe("reserved-device-name");
  });

  it("refuses a reserved device name in any case", () => {
    expect(denialCode(() => resolver().resolveLexical("src/nul"))).toBe("reserved-device-name");
  });

  it("accepts a name that merely starts with a reserved name", () => {
    expect(resolver().resolveLexical("console.log")).toBe(join(ROOT, "console.log"));
  });

  it("refuses a segment with a trailing dot", () => {
    expect(denialCode(() => resolver().resolveLexical("secret."))).toBe("trailing-dot-or-space");
  });

  it("refuses a segment with a trailing space", () => {
    expect(denialCode(() => resolver().resolveLexical("secret "))).toBe("trailing-dot-or-space");
  });

  it("refuses an 8.3 short name", () => {
    expect(denialCode(() => resolver().resolveLexical("PROGRA~1/app.exe"))).toBe("short-name");
  });

  it("accepts a tilde that is not a short-name alias", () => {
    expect(resolver().resolveLexical("~backup/file.txt")).toBe(join(ROOT, "~backup", "file.txt"));
  });
});

describe("case folding", () => {
  it("accepts a differently-cased root prefix when folding is enabled", () => {
    const instance = createWorkspacePathResolver({ root: ROOT, caseInsensitive: true });
    const shouted = ROOT.toUpperCase() + sep + "file.txt";
    expect(() => instance.resolveLexical(shouted)).not.toThrow();
  });

  it("refuses a differently-cased root prefix when folding is disabled", () => {
    const instance = createWorkspacePathResolver({ root: ROOT, caseInsensitive: false });
    const shouted = ROOT.toUpperCase() + sep + "file.txt";
    // Only meaningful when the root actually contains foldable characters.
    if (ROOT.toUpperCase() !== ROOT) {
      expect(denialCode(() => instance.resolveLexical(shouted))).toBe("escapes-root");
    }
  });
});

describe("real-path resolution", () => {
  let base: string;
  let root: string;
  let outside: string;

  beforeAll(async () => {
    base = await mkdtemp(join(tmpdir(), "zet-workspace-"));
    root = join(base, "project");
    outside = join(base, "outside");
    await mkdir(join(root, "src"), { recursive: true });
    await mkdir(outside, { recursive: true });
    await writeFile(join(root, "src", "index.ts"), "export {};\n", "utf8");
    await writeFile(join(outside, "secrets.txt"), "token\n", "utf8");
  });

  afterAll(async () => {
    await rm(base, { recursive: true, force: true });
  });

  it("resolves an existing file and reports it as existing", async () => {
    const instance = createWorkspacePathResolver({ root });
    const result = await instance.resolve("src/index.ts");
    expect(result.exists).toBe(true);
    expect(result.relativePath).toBe("src/index.ts");
  });

  it("resolves the root to a dot relative path", async () => {
    const instance = createWorkspacePathResolver({ root });
    const result = await instance.resolve(".");
    expect(result.relativePath).toBe(".");
    expect(result.exists).toBe(true);
  });

  it("accepts a path whose final component does not exist yet", async () => {
    const instance = createWorkspacePathResolver({ root });
    const result = await instance.resolve("src/created.ts");
    expect(result.exists).toBe(false);
    expect(result.relativePath).toBe("src/created.ts");
  });

  it("accepts a path whose intermediate directories do not exist yet", async () => {
    const instance = createWorkspacePathResolver({ root });
    const result = await instance.resolve("a/b/c/new.txt");
    expect(result.exists).toBe(false);
    expect(result.relativePath).toBe("a/b/c/new.txt");
  });

  it("refuses a symlinked file that points outside the root", async () => {
    const linkPath = join(root, "escape.txt");
    try {
      await symlink(join(outside, "secrets.txt"), linkPath, "file");
    } catch {
      return; // Unprivileged Windows cannot create links; the rule is proven on CI.
    }
    const instance = createWorkspacePathResolver({ root });
    await expect(instance.resolve("escape.txt")).rejects.toBeInstanceOf(WorkspacePathError);
    await rm(linkPath, { force: true });
  });

  it("refuses a path routed through a symlinked directory", async () => {
    const linkPath = join(root, "linked");
    try {
      await symlink(outside, linkPath, "junction");
    } catch {
      return;
    }
    const instance = createWorkspacePathResolver({ root });
    const code = await instance.resolve("linked/secrets.txt").then(
      () => "accepted",
      (error: unknown) => (isWorkspacePathError(error) ? error.code : "other"),
    );
    expect(code).toBe("symlink-escapes-root");
    await rm(linkPath, { force: true, recursive: true });
  });

  it("refuses a not-yet-created path underneath a symlinked directory", async () => {
    const linkPath = join(root, "linked-write");
    try {
      await symlink(outside, linkPath, "junction");
    } catch {
      return;
    }
    const instance = createWorkspacePathResolver({ root });
    const code = await instance.resolve("linked-write/new-file.txt").then(
      () => "accepted",
      (error: unknown) => (isWorkspacePathError(error) ? error.code : "other"),
    );
    expect(code).toBe("symlink-escapes-root");
    await rm(linkPath, { force: true, recursive: true });
  });

  it("accepts a symlink that stays inside the root", async () => {
    const linkPath = join(root, "inside-link.ts");
    try {
      await symlink(join(root, "src", "index.ts"), linkPath, "file");
    } catch {
      return;
    }
    const instance = createWorkspacePathResolver({ root });
    const result = await instance.resolve("inside-link.ts");
    expect(result.relativePath).toBe(join("src", "index.ts").split(sep).join("/"));
    await rm(linkPath, { force: true });
  });
});

describe("error provenance", () => {
  it("recognizes a genuine denial", () => {
    const error = new WorkspacePathError("escapes-root", "denied", "../x");
    expect(isWorkspacePathError(error)).toBe(true);
  });

  it("does not recognize a forged prototype", () => {
    const forged = Object.create(WorkspacePathError.prototype) as unknown;
    expect(isWorkspacePathError(forged)).toBe(false);
  });

  it("does not recognize a plain object carrying the same fields", () => {
    expect(isWorkspacePathError({ name: "WorkspacePathError", code: "escapes-root" })).toBe(false);
  });

  it("reports the requested path, not the host path", () => {
    try {
      resolver().resolveLexical("../secrets.txt");
    } catch (error: unknown) {
      expect(isWorkspacePathError(error)).toBe(true);
      if (isWorkspacePathError(error)) {
        expect(error.requestedPath).toBe("../secrets.txt");
        expect(error.message).not.toContain(ROOT);
      }
    }
  });
});

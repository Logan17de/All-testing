import { mkdtemp, mkdir, writeFile, symlink, rm, link } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it, expect } from "vitest";
import { readWorkspaceInstructions } from "./runtime-workspace-instructions.js";

describe("bounded native workspace instruction discovery", () => {
  it("loads root instructions and local skills without granting authority", async () => {
    const root = await mkdtemp(join(tmpdir(), "zet-instructions-"));
    try {
      await writeFile(join(root, "AGENTS.md"), "Run checks before finishing.");
      await mkdir(join(root, ".agents", "skills", "review"), { recursive: true });
      await writeFile(join(root, ".agents", "skills", "review", "SKILL.md"), "Review the diff.");
      const snapshot = await readWorkspaceInstructions(root);
      expect(snapshot.sources).toEqual(["AGENTS.md", ".agents/skills/review/SKILL.md"]);
      expect(snapshot.text).toContain("Review the diff.");
      expect(snapshot.skills).toEqual([{ name: "review", path: ".agents/skills/review/SKILL.md" }]);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
  it("refuses oversized instructions and linked external skill directories", async () => {
    const root = await mkdtemp(join(tmpdir(), "zet-instructions-"));
    const external = await mkdtemp(join(tmpdir(), "zet-external-"));
    try {
      await writeFile(join(root, "AGENTS.md"), "x".repeat(12_001));
      await writeFile(join(external, "SKILL.md"), "private external text");
      await mkdir(join(root, ".agents", "skills"), { recursive: true });
      await symlink(external, join(root, ".agents", "skills", "external"), "junction");
      expect(await readWorkspaceInstructions(root)).toEqual({ text: "", sources: [], skills: [] });
    } finally {
      await rm(root, { recursive: true, force: true });
      await rm(external, { recursive: true, force: true });
    }
  });
});

describe("explicit nested instruction scope and progressive skills", () => {
  it("loads only root-to-selected-directory AGENTS in precedence order", async () => {
    const root = await mkdtemp(join(tmpdir(), "zet-instructions-scope-"));
    try {
      await mkdir(join(root, "src", "app"), { recursive: true });
      await mkdir(join(root, "other"));
      for (const [file, body] of [
        ["AGENTS.md", "Root guidance"],
        ["src/AGENTS.md", "Source guidance"],
        ["src/app/AGENTS.md", "App guidance"],
        ["other/AGENTS.md", "Unrelated guidance"],
      ])
        await writeFile(join(root, file!), body!);
      const snapshot = await readWorkspaceInstructions(root, { workingDirectory: "src/app" });
      expect(snapshot.sources).toEqual(["AGENTS.md", "src/AGENTS.md", "src/app/AGENTS.md"]);
      expect(snapshot.text.indexOf("Root guidance")).toBeLessThan(
        snapshot.text.indexOf("Source guidance"),
      );
      expect(snapshot.text.indexOf("Source guidance")).toBeLessThan(
        snapshot.text.indexOf("App guidance"),
      );
      expect(snapshot.text).toContain("Deeper directory instructions take precedence");
      expect(snapshot.text).not.toContain("Unrelated guidance");
      expect((await readWorkspaceInstructions(root)).sources).toEqual(["AGENTS.md"]);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
  it("rejects inferred, escaping, private and linked directory scopes", async () => {
    const root = await mkdtemp(join(tmpdir(), "zet-instructions-scope-"));
    const external = await mkdtemp(join(tmpdir(), "zet-instructions-external-"));
    try {
      await symlink(external, join(root, "linked"), "junction");
      await writeFile(join(root, "file.ts"), "fixture");
      for (const workingDirectory of [
        "../escape",
        external,
        "linked",
        ".aws",
        "file.ts",
        "src\\app",
        Array(17).fill("deep").join("/"),
      ])
        await expect(readWorkspaceInstructions(root, { workingDirectory })).rejects.toBeDefined();
    } finally {
      await rm(root, { recursive: true, force: true });
      await rm(external, { recursive: true, force: true });
    }
  });
  it("catalogs bounded descriptions without exposing bodies and loads only selected skills", async () => {
    const root = await mkdtemp(join(tmpdir(), "zet-instructions-catalog-"));
    try {
      for (const name of ["review", "deploy"]) {
        await mkdir(join(root, ".agents", "skills", name), { recursive: true });
        await writeFile(
          join(root, ".agents", "skills", name, "SKILL.md"),
          `---\nname: ${name}\ndescription: ${name} description\n---\n${name} full instructions`,
        );
      }
      const catalog = await readWorkspaceInstructions(root, { skillMode: "catalog" });
      expect(catalog.sources).toEqual([]);
      expect(catalog.skills.map((skill) => skill.loaded)).toEqual([false, false]);
      expect(catalog.text).toContain("review description");
      expect(catalog.text).not.toContain("review full instructions");
      const selected = await readWorkspaceInstructions(root, {
        skillMode: "catalog",
        skillNames: ["review"],
      });
      expect(selected.sources).toEqual([".agents/skills/review/SKILL.md"]);
      expect(selected.text).toContain("review full instructions");
      expect(selected.text).not.toContain("deploy full instructions");
      expect(selected.skills.find((skill) => skill.name === "review")?.loaded).toBe(true);
      await expect(readWorkspaceInstructions(root, { skillNames: ["missing"] })).rejects.toThrow(
        "Selected workspace skill is unavailable",
      );
      await expect(readWorkspaceInstructions(root, { skillNames: ["../review"] })).rejects.toThrow(
        "scope",
      );
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
  it("fails closed rather than dropping applicable deeper instructions when the budget is exhausted", async () => {
    const root = await mkdtemp(join(tmpdir(), "zet-instructions-budget-"));
    try {
      await mkdir(join(root, "a", "b"), { recursive: true });
      await writeFile(join(root, "AGENTS.md"), "r".repeat(12000));
      await writeFile(join(root, "a", "AGENTS.md"), "a".repeat(12000));
      await writeFile(join(root, "a", "b", "AGENTS.md"), "b");
      await expect(readWorkspaceInstructions(root, { workingDirectory: "a/b" })).rejects.toThrow(
        "context budget",
      );
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
  it("refuses linked and invalid UTF-8 instruction bodies", async () => {
    const root = await mkdtemp(join(tmpdir(), "zet-instructions-bytes-"));
    try {
      await writeFile(join(root, "source.md"), "private linked fixture");
      await link(join(root, "source.md"), join(root, "AGENTS.md"));
      expect((await readWorkspaceInstructions(root)).sources).toEqual([]);
      await rm(join(root, "AGENTS.md"));
      await writeFile(join(root, "AGENTS.md"), Buffer.from([0xc3, 0x28]));
      expect((await readWorkspaceInstructions(root)).sources).toEqual([]);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});

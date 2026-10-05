import { mkdtemp, mkdir, writeFile, symlink, rm } from "node:fs/promises";
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

import { lstat, open, opendir, realpath } from "node:fs/promises";
import { constants } from "node:fs";
import { join, relative, resolve, sep } from "node:path";

export interface WorkspaceInstructionSnapshot {
  readonly text: string;
  readonly sources: readonly string[];
  readonly skills: readonly { readonly name: string; readonly path: string }[];
}

/** Workspace text is context, never authority to grant tools or credentials. */
export async function readWorkspaceInstructions(
  root: string,
): Promise<WorkspaceInstructionSnapshot> {
  const canonicalRoot = await realpath(root);
  const sources: string[] = [];
  const sections: string[] = [];
  const skills: { name: string; path: string }[] = [];
  let remaining = 24_000;
  async function read(path: string): Promise<string | undefined> {
    try {
      const candidate = resolve(canonicalRoot, path);
      const components = relative(canonicalRoot, candidate).split(sep);
      if (components.some((component) => component === "..")) return undefined;
      let current = canonicalRoot;
      for (const component of components) {
        current = join(current, component);
        if ((await lstat(current)).isSymbolicLink()) return undefined;
      }
      const handle = await open(candidate, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
      try {
        const stat = await handle.stat();
        if (!stat.isFile() || stat.nlink !== 1 || stat.size > 12_000 || stat.size > remaining)
          return undefined;
        const canonical = await realpath(candidate);
        if (canonical !== candidate) return undefined;
        const buffer = Buffer.alloc(stat.size + 1);
        const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
        if (bytesRead > stat.size) return undefined;
        remaining -= bytesRead;
        sources.push(path);
        return buffer.subarray(0, bytesRead).toString("utf8");
      } finally {
        await handle.close();
      }
    } catch {
      return undefined;
    }
  }
  const instructions = await read("AGENTS.md");
  if (instructions !== undefined)
    sections.push(`Workspace instructions (AGENTS.md):\n${instructions}`);
  // Deterministic, bounded discovery; no home directory or arbitrary filesystem scan.
  try {
    const skillRoot = join(canonicalRoot, ".agents", "skills");
    if (
      !(await lstat(join(canonicalRoot, ".agents"))).isSymbolicLink() &&
      !(await lstat(skillRoot)).isSymbolicLink()
    ) {
      const entries = [];
      const directory = await opendir(skillRoot);
      for await (const entry of directory) {
        entries.push(entry);
        if (entries.length >= 100) break;
      }
      entries.sort((a, b) => a.name.localeCompare(b.name));
      for (const entry of entries.slice(0, 20)) {
        if (!entry.isDirectory() || entry.isSymbolicLink()) continue;
        const path = `.agents/skills/${entry.name}/SKILL.md`;
        const text = await read(path);
        if (text === undefined) continue;
        skills.push({ name: entry.name, path });
        sections.push(`Workspace skill (${path}):\n${text}`);
      }
    }
  } catch {
    /* Optional skill directory. */
  }
  return { text: sections.join("\n\n"), sources, skills };
}

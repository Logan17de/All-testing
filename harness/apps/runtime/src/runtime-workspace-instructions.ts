import { lstat, open, opendir, realpath } from "node:fs/promises";
import { constants } from "node:fs";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import { isBlockedWorkspacePathSegment } from "./runtime-workspace-read-tools.js";

export interface WorkspaceInstructionSnapshot {
  readonly text: string;
  readonly sources: readonly string[];
  readonly skills: readonly {
    readonly name: string;
    readonly path: string;
    readonly description?: string;
    readonly loaded?: boolean;
  }[];
}
export interface WorkspaceInstructionOptions {
  /** Explicit host-selected workspace-relative directory. No target is inferred from a prompt. */
  readonly workingDirectory?: string;
  /** Catalog descriptions first; selected skillNames still load their full bounded body. */
  readonly skillMode?: "full" | "catalog";
  readonly skillNames?: readonly string[];
}
const invalid = (): Error => new Error("Invalid workspace instruction scope.");
function selectedParts(value: string | undefined): string[] {
  if (value === undefined || value === ".") return [];
  if (
    typeof value !== "string" ||
    value.length > 4096 ||
    isAbsolute(value) ||
    value.includes("\\") ||
    /^[a-z]:/iu.test(value) ||
    value.includes("\0")
  )
    throw invalid();
  const parts = value.split("/");
  if (
    parts.length > 16 ||
    parts.some(
      (part) => !part || part === "." || part === ".." || isBlockedWorkspacePathSegment(part),
    )
  )
    throw invalid();
  return parts;
}
function skillDescription(text: string): string {
  if (!text.startsWith("---\n") && !text.startsWith("---\r\n"))
    return "Local workspace skill; select it to load its instructions.";
  const header = text.split(/\r?\n/u).slice(1, 40);
  const end = header.indexOf("---");
  const match = header
    .slice(0, end < 0 ? header.length : end)
    .find((line) => /^description:\s*[^>|]/u.test(line));
  return match
    ? match
        .replace(/^description:\s*/u, "")
        .replace(/^['"]|['"]$/gu, "")
        .slice(0, 300)
    : "Local workspace skill; select it to load its instructions.";
}

/** Workspace text supplies instructions within its directory scope, never tool or credential authority. */
export async function readWorkspaceInstructions(
  root: string,
  options: WorkspaceInstructionOptions = {},
): Promise<WorkspaceInstructionSnapshot> {
  if (
    Object.keys(options).some(
      (key) => !["workingDirectory", "skillMode", "skillNames"].includes(key),
    ) ||
    (options.skillMode !== undefined && !["full", "catalog"].includes(options.skillMode)) ||
    (options.skillNames !== undefined &&
      (!Array.isArray(options.skillNames) ||
        options.skillNames.length > 20 ||
        new Set(options.skillNames).size !== options.skillNames.length ||
        !options.skillNames.every(
          (name) => typeof name === "string" && /^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/u.test(name),
        )))
  )
    throw invalid();
  const scope = selectedParts(options.workingDirectory);
  const canonicalRoot = await realpath(root);
  if (canonicalRoot.split(sep).some(isBlockedWorkspacePathSegment)) throw invalid();
  let current = canonicalRoot;
  for (const part of scope) {
    current = join(current, part);
    const stat = await lstat(current);
    if (!stat.isDirectory() || stat.isSymbolicLink() || (await realpath(current)) !== current)
      throw invalid();
  }
  const sources: string[] = [];
  const sections: string[] = [];
  const skills: { name: string; path: string; description?: string; loaded?: boolean }[] = [];
  let remaining = 24_000;
  async function read(filePath: string): Promise<string | undefined> {
    try {
      const candidate = resolve(canonicalRoot, filePath);
      const components = relative(canonicalRoot, candidate).split(sep);
      if (
        components.some(
          (component) => component === ".." || isBlockedWorkspacePathSegment(component),
        )
      )
        return undefined;
      let parent = canonicalRoot;
      for (const component of components) {
        parent = join(parent, component);
        if ((await lstat(parent)).isSymbolicLink()) return undefined;
      }
      const handle = await open(
        candidate,
        constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0),
      );
      try {
        const stat = await handle.stat();
        if (
          !stat.isFile() ||
          stat.nlink !== 1 ||
          stat.size > 12_000 ||
          (await realpath(candidate)) !== candidate
        )
          return undefined;
        const buffer = Buffer.alloc(stat.size + 1);
        let count = 0;
        while (count < buffer.length) {
          const result = await handle.read(buffer, count, buffer.length - count, count);
          if (!result.bytesRead) break;
          count += result.bytesRead;
        }
        const final = await handle.stat();
        if (
          count !== stat.size ||
          final.size !== stat.size ||
          final.mtimeMs !== stat.mtimeMs ||
          final.nlink !== 1
        )
          return undefined;
        return new TextDecoder("utf-8", { fatal: true }).decode(buffer.subarray(0, count));
      } finally {
        await handle.close();
      }
    } catch {
      return undefined;
    }
  }
  const instructionPaths = [
    "AGENTS.md",
    ...scope.map((_, index) => `${scope.slice(0, index + 1).join("/")}/AGENTS.md`),
  ];
  for (const filePath of instructionPaths) {
    const body = await read(filePath);
    if (body === undefined) continue;
    const bytes = Buffer.byteLength(body);
    if (bytes > remaining)
      throw new Error("Applicable workspace instructions exceed the context budget.");
    remaining -= bytes;
    sources.push(filePath);
    sections.push(
      `Workspace instructions (${filePath}; applies to its directory and descendants):\n${body}`,
    );
  }
  if (scope.length && sections.length)
    sections.unshift(
      "Applicable AGENTS.md files are ordered from workspace root to selected working directory. Deeper directory instructions take precedence within that subtree; host and user instructions remain authoritative. Unrelated descendant instruction files are not loaded.",
    );
  try {
    const skillRoot = join(canonicalRoot, ".agents", "skills");
    if (
      !(await lstat(join(canonicalRoot, ".agents"))).isSymbolicLink() &&
      !(await lstat(skillRoot)).isSymbolicLink()
    ) {
      const entries = [];
      for await (const entry of await opendir(skillRoot)) {
        entries.push(entry);
        if (entries.length >= 100) break;
      }
      entries.sort((a, b) => a.name.localeCompare(b.name));
      for (const entry of entries
        .filter(
          (item) =>
            item.isDirectory() &&
            !item.isSymbolicLink() &&
            /^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/u.test(item.name),
        )
        .slice(0, 20)) {
        const filePath = `.agents/skills/${entry.name}/SKILL.md`;
        const body = await read(filePath);
        if (body === undefined) continue;
        const load =
          options.skillNames !== undefined
            ? options.skillNames.includes(entry.name)
            : options.skillMode !== "catalog";
        if (load && Buffer.byteLength(body) <= remaining) {
          remaining -= Buffer.byteLength(body);
          sources.push(filePath);
          skills.push({
            name: entry.name,
            path: filePath,
            ...(options.skillMode === "catalog" || options.skillNames !== undefined
              ? { description: skillDescription(body), loaded: true }
              : {}),
          });
          sections.push(`Workspace skill (${filePath}):\n${body}`);
        } else if (options.skillMode === "catalog" || options.skillNames !== undefined) {
          const description = skillDescription(body);
          if (Buffer.byteLength(description) > remaining) continue;
          remaining -= Buffer.byteLength(description);
          skills.push({ name: entry.name, path: filePath, description, loaded: false });
          sections.push(
            `Available workspace skill ${entry.name} (${filePath}; body not loaded): ${description}`,
          );
        }
      }
    }
  } catch {
    /* Optional skill directory; no scan above or outside workspace. */
  }
  if (
    options.skillNames?.some(
      (name) => !skills.some((skill) => skill.name === name && skill.loaded === true),
    )
  )
    throw new Error("Selected workspace skill is unavailable or exceeds the context budget.");
  return { text: sections.join("\n\n"), sources, skills };
}

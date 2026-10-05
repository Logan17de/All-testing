import { constants } from "node:fs";
import { open, realpath, opendir, type FileHandle } from "node:fs/promises";
import path from "node:path";

const LIMIT = 64 * 1024;
export const isBlockedCodexPathSegment = (name: string): boolean =>
  /^(?:\.env.*|\.git|\.git-credentials|\.zet-codex|\.bash_history|\.zsh_history|\.gcloud|\.codex|\.aws|\.ssh|\.azure|\.config|\.gnupg|\.kube|\.docker|\.npmrc|\.netrc|\.pypirc|auth\.json|credentials(?:\..*)?|secrets?(?:\..*)?|id_(?:rsa|dsa|ecdsa|ed25519)(?:\..*)?)$/i.test(
    name,
  ) ||
  /(?:\.(?:pem|key|p12|pfx|jks|keystore)$|(?:^|[._-])(?:token|password|private[._-]?key)(?:[._-]|$))/i.test(
    name,
  );
export const CODEX_DYNAMIC_TOOLS = [
  {
    type: "function" as const,
    name: "zet_workspace_read_file",
    description: "Read a UTF-8 workspace file up to 64 KiB, excluding credentials and symlinks.",
    inputSchema: {
      type: "object",
      properties: { path: { type: "string" } },
      required: ["path"],
      additionalProperties: false,
    },
  },
  {
    type: "function" as const,
    name: "zet_workspace_list",
    description: "List up to 200 workspace entries, excluding credentials and symlinks.",
    inputSchema: {
      type: "object",
      properties: { path: { type: "string" } },
      additionalProperties: false,
    },
  },
];
export interface CodexDynamicToolResult {
  contentItems: { type: "inputText"; text: string }[];
  success: boolean;
}
function partsFor(args: unknown, reading: boolean): string[] {
  if (!args || typeof args !== "object" || Array.isArray(args)) throw new Error();
  const record = args as Record<string, unknown>;
  if (Object.keys(record).some((key) => key !== "path")) throw new Error();
  if (record.path === undefined && !reading) return [];
  const value = record.path;
  if (
    typeof value !== "string" ||
    !value ||
    value.length > 4096 ||
    value.includes("\0") ||
    value.includes("\\") ||
    path.isAbsolute(value) ||
    /^[a-z]:/i.test(value)
  )
    throw new Error();
  const parts = value.split("/");
  if (parts.some((part) => part === ".." || isBlockedCodexPathSegment(part))) throw new Error();
  const filtered = parts.filter((part) => part && part !== ".");
  if (reading && !filtered.length) throw new Error();
  return filtered;
}
// Descriptor-relative Linux traversal anchors every directory against symlink
// replacement races. Unsupported systems fail closed rather than weaken confinement.
async function confinedOpen(
  root: string,
  parts: string[],
  directory: boolean,
): Promise<FileHandle> {
  if (process.platform !== "linux") throw new Error();
  const canonical = await realpath(root);
  if (canonical.split(path.sep).some(isBlockedCodexPathSegment)) throw new Error();
  let handle = await open(
    canonical,
    constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW,
  );
  try {
    if ((await realpath(`/proc/self/fd/${handle.fd}`)) !== canonical) throw new Error();
    for (let index = 0; index < parts.length; index++) {
      const next = await open(
        `/proc/self/fd/${handle.fd}/${parts[index]}`,
        constants.O_RDONLY |
          constants.O_NOFOLLOW |
          constants.O_NONBLOCK |
          (index < parts.length - 1 || directory ? constants.O_DIRECTORY : 0),
      );
      await handle.close();
      handle = next;
      const relative = path.relative(canonical, await realpath(`/proc/self/fd/${handle.fd}`));
      if (
        relative === ".." ||
        relative.startsWith(`..${path.sep}`) ||
        path.isAbsolute(relative) ||
        relative.split(path.sep).some(isBlockedCodexPathSegment)
      )
        throw new Error();
    }
    return handle;
  } catch (error) {
    await handle.close();
    throw error;
  }
}
export async function executeCodexDynamicTool(
  root: string,
  tool: string,
  args: unknown,
): Promise<CodexDynamicToolResult> {
  let handle: FileHandle | undefined;
  try {
    if (tool !== "zet_workspace_read_file" && tool !== "zet_workspace_list") throw new Error();
    const reading = tool === "zet_workspace_read_file";
    handle = await confinedOpen(root, partsFor(args, reading), !reading);
    let text: string;
    if (reading) {
      const stat = await handle.stat();
      if (!stat.isFile() || stat.nlink !== 1 || stat.size > LIMIT) throw new Error();
      const buffer = Buffer.alloc(LIMIT + 1);
      const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
      if (bytesRead > LIMIT) throw new Error();
      text = new TextDecoder("utf-8", { fatal: true }).decode(buffer.subarray(0, bytesRead));
      if (text.includes("\0")) throw new Error();
    } else {
      const entries: { name: string; type: string }[] = [];
      const directory = await opendir(`/proc/self/fd/${handle.fd}`);
      let scanned = 0;
      let truncated = false;
      for await (const entry of directory) {
        // Bound scanning too: credential-heavy directories must not exhaust resources.
        if (++scanned > 2000 || entries.length === 200) {
          truncated = true;
          break;
        }
        if (
          isBlockedCodexPathSegment(entry.name) ||
          entry.isSymbolicLink() ||
          (!entry.isFile() && !entry.isDirectory())
        )
          continue;
        entries.push({ name: entry.name, type: entry.isDirectory() ? "directory" : "file" });
      }
      entries.sort((a, b) => a.name.localeCompare(b.name));
      text = JSON.stringify({ entries, truncated });
    }
    if (Buffer.byteLength(text) > LIMIT) throw new Error();
    return { contentItems: [{ type: "inputText", text }], success: true };
  } catch {
    // Never return OS errors containing private host paths or file contents.
    return {
      contentItems: [
        {
          type: "inputText",
          text: "Workspace tool rejected the request or could not access the permitted resource.",
        },
      ],
      success: false,
    };
  } finally {
    await handle?.close();
  }
}

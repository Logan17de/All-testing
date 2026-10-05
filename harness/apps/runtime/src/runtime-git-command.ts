import type { JsonObject } from "@zet-harness/plugin-api";
import { isBlockedWorkspacePathSegment } from "./runtime-workspace-read-tools.js";

export type GitOperation = "status" | "diff" | "log" | "add" | "commit" | "staged-paths";
const PREFIX = [
  "--no-pager",
  "-c",
  "core.hooksPath=/dev/null",
  "-c",
  "core.fsmonitor=false",
  "-c",
  "core.untrackedCache=false",
  "-c",
  "protocol.file.allow=never",
];
const refuse = () => new Error("Scoped Git request refused.");
export function gitPaths(value: unknown): readonly string[] {
  if (!Array.isArray(value) || !value.length || value.length > 20) throw refuse();
  const paths = value.map((item: unknown) => {
    if (
      typeof item !== "string" ||
      Buffer.byteLength(item) > 1024 ||
      /[\\\x00-\x1f:*?\[\]]/u.test(item) ||
      item.startsWith("/") ||
      item
        .split("/")
        .some(
          (part) =>
            !part ||
            part === "." ||
            part === ".." ||
            isBlockedWorkspacePathSegment(part) ||
            ["node_modules", ".next", ".turbo", "dist", "build", "coverage"].includes(part),
        )
    )
      throw refuse();
    return item;
  });
  if (new Set(paths).size !== paths.length) throw refuse();
  return Object.freeze(paths);
}
export function buildGitCommand(operation: GitOperation, input: JsonObject): readonly string[] {
  const allowed =
    operation === "commit"
      ? ["paths", "message", "authorName", "authorEmail"]
      : operation === "diff"
        ? ["paths", "staged"]
        : operation === "add"
          ? ["paths"]
          : [];
  if (Object.keys(input).some((key) => !allowed.includes(key))) throw refuse();
  let suffix: string[];
  if (operation === "status") suffix = ["status", "--porcelain=v1", "--ignore-submodules=all"];
  else if (operation === "log") suffix = ["log", "-10", "--format=%h %s", "--no-show-signature"];
  else if (operation === "staged-paths")
    suffix = [
      "diff",
      "--cached",
      "--name-only",
      "-z",
      "--no-ext-diff",
      "--no-textconv",
      "--ignore-submodules=all",
    ];
  else if (operation === "diff") {
    if (input.staged !== undefined && typeof input.staged !== "boolean") throw refuse();
    suffix = [
      "diff",
      ...(input.staged === true ? ["--cached"] : []),
      "--no-ext-diff",
      "--no-textconv",
      "--ignore-submodules=all",
      "--",
      ...gitPaths(input.paths),
    ];
  } else if (operation === "add") suffix = ["add", "--", ...gitPaths(input.paths)];
  else {
    gitPaths(input.paths);
    for (const key of ["message", "authorName", "authorEmail"])
      if (
        typeof input[key] !== "string" ||
        !input[key].trim() ||
        input[key].length > (key === "message" ? 2048 : 128) ||
        /[\x00-\x1f\x7f]/u.test(input[key])
      )
        throw refuse();
    if (!/^[A-Za-z0-9._+%-]+@[A-Za-z0-9.-]+$/u.test(input.authorEmail as string)) throw refuse();
    suffix = [
      "-c",
      `user.name=${input.authorName as string}`,
      "-c",
      `user.email=${input.authorEmail as string}`,
      "commit",
      "--no-verify",
      "--no-gpg-sign",
      "-m",
      input.message as string,
    ];
  }
  return Object.freeze([...PREFIX, ...suffix]);
}
/** Only exact builder-produced argv qualify at the independent sandbox boundary. */
export function classifySafeGitArgs(args: readonly string[]): "read" | "write" | undefined {
  if (JSON.stringify(args.slice(0, PREFIX.length)) !== JSON.stringify(PREFIX)) return;
  const suffix = args.slice(PREFIX.length);
  for (const operation of ["status", "log", "staged-paths"] as const)
    if (JSON.stringify(args) === JSON.stringify(buildGitCommand(operation, {}))) return "read";
  for (const operation of ["diff", "add"] as const) {
    const split = suffix.indexOf("--");
    if (split < 0) continue;
    try {
      const input: JsonObject = {
        paths: [...suffix.slice(split + 1)],
        ...(operation === "diff" ? { staged: suffix.includes("--cached") } : {}),
      };
      if (JSON.stringify(args) === JSON.stringify(buildGitCommand(operation, input)))
        return operation === "add" ? "write" : "read";
    } catch {
      /* Refuse malformed paths. */
    }
  }
  if (suffix.length === 9 && suffix[0] === "-c" && suffix[2] === "-c" && suffix[4] === "commit") {
    try {
      const input = {
        paths: ["validation-only"],
        authorName: suffix[1]?.replace(/^user.name=/u, ""),
        authorEmail: suffix[3]?.replace(/^user.email=/u, ""),
        message: suffix[8],
      } as JsonObject;
      if (JSON.stringify(args) === JSON.stringify(buildGitCommand("commit", input))) return "write";
    } catch {
      /* Refuse malformed identity. */
    }
  }
  return;
}

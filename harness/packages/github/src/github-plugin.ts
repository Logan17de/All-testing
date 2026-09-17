import {
  PLUGIN_API_VERSION,
  type AdapterInvocationContext,
  type HarnessPlugin,
  type JsonObject,
  type JsonSchema,
  type JsonValue,
  type NodeBehavior,
  type ToolAdapter,
  type ToolResult,
} from "@zet-harness/plugin-api";

export const GITHUB_PLUGIN_ID = "harness.github-plugin" as const;
export const GITHUB_COMPONENT_NODE_TYPE = "github.component" as const;
export const GITHUB_API_BASE_URL = "https://api.github.com";

/** The tools a GitHub component hands to an agent step. */
export const GITHUB_TOOL_IDS = Object.freeze({
  repository: "github.repo.get",
  issues: "github.issues.list",
  issue: "github.issue.get",
  pulls: "github.pulls.list",
  file: "github.file.get",
});

export interface GitHubPluginOptions {
  /** Read when a request is made; public data is readable without one. */
  readonly token?: () => string | undefined;
  readonly fetch?: typeof globalThis.fetch;
  /** Defaults to GitHub's public API; a GitHub Enterprise server's API also works. */
  readonly apiBaseUrl?: string;
  readonly timeoutMs?: number;
}

const LIST_LIMIT = 30;
const TEXT_LIMIT = 4_000;
const FILE_LIMIT_BYTES = 64_000;

const OWNER = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})$/u;
const REPO = /^[A-Za-z0-9._-]{1,100}$/u;

const READ: NodeBehavior = {
  primitiveFamily: "effect",
  determinism: "nondeterministic",
  effect: "external-read",
  idempotency: "idempotent",
  recovery: "rerun",
  executionMode: "in-process",
  requiredCapabilities: ["network:https"],
};

const COMPONENT: NodeBehavior = {
  primitiveFamily: "pure",
  determinism: "deterministic",
  effect: "none",
  idempotency: "not-applicable",
  recovery: "rerun",
  executionMode: "in-process",
  requiredCapabilities: [],
};

const OUTPUT: JsonSchema = {
  type: "object",
  required: ["ok"],
  properties: { ok: { type: "boolean" } },
};

const REPOSITORY_INPUT = {
  owner: { type: "string", description: "The account or organisation, e.g. vercel." },
  repo: { type: "string", description: "The repository name, e.g. next.js." },
};

const STATE_INPUT = {
  type: "string",
  enum: ["open", "closed", "all"],
  description: "Defaults to open.",
};

function schema(properties: Record<string, JsonValue>, required: readonly string[]): JsonSchema {
  return { type: "object", properties, required: [...required], additionalProperties: false };
}

/** Something the model asked for that GitHub cannot answer; returned, not thrown. */
class GitHubRefusal extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = "GitHubRefusal";
    this.code = code;
  }
}

function refuse(code: string, message: string): never {
  throw new GitHubRefusal(code, message);
}

function text(input: JsonObject, field: string, required = true): string | undefined {
  const value = input[field];
  if (value === undefined && !required) return undefined;
  if (typeof value !== "string" || value.trim().length === 0) {
    return refuse("GITHUB_INPUT_INVALID", `${field} must be text.`);
  }
  return value.trim();
}

function repositoryOf(input: JsonObject): { readonly owner: string; readonly repo: string } {
  const owner = text(input, "owner") ?? "";
  const repo = text(input, "repo") ?? "";
  if (!OWNER.test(owner))
    refuse("GITHUB_INPUT_INVALID", `'${owner}' is not a GitHub account name.`);
  if (!REPO.test(repo) || repo === "." || repo === "..") {
    refuse("GITHUB_INPUT_INVALID", `'${repo}' is not a GitHub repository name.`);
  }
  return { owner, repo };
}

function stateOf(input: JsonObject): string {
  const state = text(input, "state", false) ?? "open";
  if (!["open", "closed", "all"].includes(state)) {
    refuse("GITHUB_INPUT_INVALID", "state must be open, closed or all.");
  }
  return state;
}

function limitOf(input: JsonObject): number {
  const value = input["limit"];
  if (value === undefined) return 10;
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 1) {
    return refuse("GITHUB_INPUT_INVALID", "limit must be a whole number of at least 1.");
  }
  return Math.min(value, LIST_LIMIT);
}

function trimmed(value: unknown, limit = TEXT_LIMIT): string | null {
  if (typeof value !== "string") return null;
  return value.length > limit ? `${value.slice(0, limit)}…` : value;
}

function record(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function login(value: unknown): string | null {
  const name = record(value)["login"];
  return typeof name === "string" ? name : null;
}

function labels(value: unknown): string[] {
  return Array.isArray(value)
    ? value.flatMap((label) => {
        const name = record(label)["name"];
        return typeof name === "string" ? [name] : [];
      })
    : [];
}

/** A path inside a repository, with nothing that could climb out of it. */
function filePath(input: JsonObject): string {
  const path = text(input, "path") ?? "";
  const segments = path.replace(/^\/+/u, "").split("/");
  if (
    segments.length === 0 ||
    segments.some((segment) => segment.length === 0 || segment === "." || segment === "..")
  ) {
    refuse("GITHUB_INPUT_INVALID", `'${path}' is not a file path in a repository.`);
  }
  return segments.map((segment) => encodeURIComponent(segment)).join("/");
}

/**
 * GitHub, as tools an agent can call and a component that hands them over.
 *
 * Everything here reads: repositories, issues, pull requests and files. Nothing
 * writes to GitHub, so nothing needs a person's approval yet. A token is optional —
 * public repositories answer without one, at GitHub's lower rate — and is read at
 * the moment a request is made, never stored or returned.
 *
 * The component is how a workflow opts in: its `tools` output names these tools,
 * and an agent step offers them only when that output is wired into it.
 */
export function createGitHubTools(options: GitHubPluginOptions = {}): readonly ToolAdapter[] {
  const transport = options.fetch ?? globalThis.fetch.bind(globalThis);
  const base = (options.apiBaseUrl ?? GITHUB_API_BASE_URL).replace(/\/+$/u, "");
  const timeoutMs = options.timeoutMs ?? 20_000;
  // A token only travels over https, or to a server on this machine.
  const endpoint = new URL(base);
  const tokenAllowed =
    endpoint.protocol === "https:" ||
    ["127.0.0.1", "localhost", "[::1]"].includes(endpoint.hostname);

  const get = async (path: string, context: AdapterInvocationContext): Promise<unknown> => {
    context.signal.throwIfAborted();
    const headers: Record<string, string> = {
      accept: "application/vnd.github+json",
      "x-github-api-version": "2022-11-28",
      "user-agent": "zet-harness",
    };
    const token = tokenAllowed ? options.token?.() : undefined;
    if (token !== undefined && token.length > 0) headers["authorization"] = `Bearer ${token}`;
    let response: Response;
    try {
      response = await transport(`${base}${path}`, {
        headers,
        redirect: "error",
        signal: AbortSignal.any([context.signal, AbortSignal.timeout(timeoutMs)]),
      });
    } catch {
      context.signal.throwIfAborted();
      return refuse("GITHUB_UNREACHABLE", "GitHub could not be reached.");
    }
    if (response.status === 404) {
      return refuse("GITHUB_NOT_FOUND", "GitHub has nothing at that address, or it is private.");
    }
    if (response.status === 403 || response.status === 429) {
      if (response.headers.get("x-ratelimit-remaining") === "0") {
        return refuse(
          "GITHUB_RATE_LIMITED",
          "GitHub's request limit is used up for now. A token raises it.",
        );
      }
      return refuse("GITHUB_FORBIDDEN", "GitHub refused the request.");
    }
    if (response.status === 401) {
      return refuse("GITHUB_UNAUTHORIZED", "GitHub did not accept the token.");
    }
    if (!response.ok) {
      return refuse("GITHUB_ERROR", `GitHub answered ${String(response.status)}.`);
    }
    try {
      return (await response.json()) as unknown;
    } catch {
      return refuse("GITHUB_ERROR", "GitHub's answer could not be read.");
    }
  };

  const tool = (
    id: string,
    title: string,
    description: string,
    inputSchema: JsonSchema,
    perform: (input: JsonObject, context: AdapterInvocationContext) => Promise<JsonObject>,
  ): ToolAdapter =>
    Object.freeze({
      manifest: Object.freeze({
        id,
        version: "1",
        title,
        description,
        inputSchema,
        outputSchema: OUTPUT,
        behavior: READ,
      }),
      invoke: async (input: JsonObject, context: AdapterInvocationContext): Promise<ToolResult> => {
        try {
          return { value: { ok: true, ...(await perform(input, context)) } };
        } catch (error) {
          if (error instanceof GitHubRefusal) {
            return { value: { ok: false, error: { code: error.code, reason: error.message } } };
          }
          throw error;
        }
      },
    });

  return Object.freeze([
    tool(
      GITHUB_TOOL_IDS.repository,
      "Read a GitHub repository",
      "Describe a GitHub repository: what it is, its default branch, stars and open issues.",
      schema(REPOSITORY_INPUT, ["owner", "repo"]),
      async (input, context) => {
        const { owner, repo } = repositoryOf(input);
        const found = record(await get(`/repos/${owner}/${repo}`, context));
        return {
          repository: {
            name: typeof found["full_name"] === "string" ? found["full_name"] : `${owner}/${repo}`,
            description: trimmed(found["description"]),
            defaultBranch:
              typeof found["default_branch"] === "string" ? found["default_branch"] : null,
            stars: typeof found["stargazers_count"] === "number" ? found["stargazers_count"] : null,
            openIssues:
              typeof found["open_issues_count"] === "number" ? found["open_issues_count"] : null,
            private: found["private"] === true,
            url: typeof found["html_url"] === "string" ? found["html_url"] : null,
          },
        };
      },
    ),
    tool(
      GITHUB_TOOL_IDS.issues,
      "List GitHub issues",
      "List a repository's issues, newest first. Pull requests are left out.",
      schema(
        {
          ...REPOSITORY_INPUT,
          state: STATE_INPUT,
          limit: { type: "integer", minimum: 1, maximum: LIST_LIMIT },
        },
        ["owner", "repo"],
      ),
      async (input, context) => {
        const { owner, repo } = repositoryOf(input);
        const query = new URLSearchParams({
          state: stateOf(input),
          per_page: String(limitOf(input)),
        });
        const listed = await get(`/repos/${owner}/${repo}/issues?${query.toString()}`, context);
        const issues = (Array.isArray(listed) ? listed : [])
          .map(record)
          .filter((issue) => issue["pull_request"] === undefined)
          .map((issue) => ({
            number: typeof issue["number"] === "number" ? issue["number"] : null,
            title: trimmed(issue["title"], 300),
            state: typeof issue["state"] === "string" ? issue["state"] : null,
            author: login(issue["user"]),
            labels: labels(issue["labels"]),
            comments: typeof issue["comments"] === "number" ? issue["comments"] : 0,
            url: typeof issue["html_url"] === "string" ? issue["html_url"] : null,
          }));
        return { issues };
      },
    ),
    tool(
      GITHUB_TOOL_IDS.issue,
      "Read a GitHub issue",
      "Read one issue or pull request: its title, state, author, labels and text.",
      schema({ ...REPOSITORY_INPUT, number: { type: "integer", minimum: 1 } }, [
        "owner",
        "repo",
        "number",
      ]),
      async (input, context) => {
        const { owner, repo } = repositoryOf(input);
        const number = input["number"];
        if (typeof number !== "number" || !Number.isSafeInteger(number) || number < 1) {
          refuse("GITHUB_INPUT_INVALID", "number must be an issue number.");
        }
        const issue = record(
          await get(`/repos/${owner}/${repo}/issues/${String(number)}`, context),
        );
        return {
          issue: {
            number,
            title: trimmed(issue["title"], 300),
            state: typeof issue["state"] === "string" ? issue["state"] : null,
            author: login(issue["user"]),
            labels: labels(issue["labels"]),
            body: trimmed(issue["body"]),
            comments: typeof issue["comments"] === "number" ? issue["comments"] : 0,
            isPullRequest: issue["pull_request"] !== undefined,
            url: typeof issue["html_url"] === "string" ? issue["html_url"] : null,
          },
        };
      },
    ),
    tool(
      GITHUB_TOOL_IDS.pulls,
      "List GitHub pull requests",
      "List a repository's pull requests, newest first.",
      schema(
        {
          ...REPOSITORY_INPUT,
          state: STATE_INPUT,
          limit: { type: "integer", minimum: 1, maximum: LIST_LIMIT },
        },
        ["owner", "repo"],
      ),
      async (input, context) => {
        const { owner, repo } = repositoryOf(input);
        const query = new URLSearchParams({
          state: stateOf(input),
          per_page: String(limitOf(input)),
        });
        const listed = await get(`/repos/${owner}/${repo}/pulls?${query.toString()}`, context);
        const pulls = (Array.isArray(listed) ? listed : []).map(record).map((pull) => ({
          number: typeof pull["number"] === "number" ? pull["number"] : null,
          title: trimmed(pull["title"], 300),
          state: typeof pull["state"] === "string" ? pull["state"] : null,
          author: login(pull["user"]),
          draft: pull["draft"] === true,
          url: typeof pull["html_url"] === "string" ? pull["html_url"] : null,
        }));
        return { pulls };
      },
    ),
    tool(
      GITHUB_TOOL_IDS.file,
      "Read a file on GitHub",
      "Read a text file from a repository, at its default branch or a given branch, tag or commit.",
      schema(
        {
          ...REPOSITORY_INPUT,
          path: {
            type: "string",
            description: "The file's path in the repository, e.g. README.md.",
          },
          ref: { type: "string", description: "A branch, tag or commit. Optional." },
        },
        ["owner", "repo", "path"],
      ),
      async (input, context) => {
        const { owner, repo } = repositoryOf(input);
        const path = filePath(input);
        const ref = text(input, "ref", false);
        if (ref !== undefined && !/^[A-Za-z0-9._\-/]{1,200}$/u.test(ref)) {
          refuse("GITHUB_INPUT_INVALID", `'${ref}' is not a branch, tag or commit.`);
        }
        const query = ref === undefined ? "" : `?${new URLSearchParams({ ref }).toString()}`;
        const found = await get(`/repos/${owner}/${repo}/contents/${path}${query}`, context);
        if (Array.isArray(found)) {
          return refuse("GITHUB_NOT_A_FILE", "That path is a folder, not a file.");
        }
        const file = record(found);
        if (file["type"] !== "file" || file["encoding"] !== "base64") {
          return refuse("GITHUB_NOT_A_FILE", "That path is not a readable file.");
        }
        const size = typeof file["size"] === "number" ? file["size"] : 0;
        if (size > FILE_LIMIT_BYTES) {
          return refuse(
            "GITHUB_FILE_TOO_LARGE",
            `The file is ${String(size)} bytes; only files up to ${String(FILE_LIMIT_BYTES)} bytes are read.`,
          );
        }
        let content: string;
        try {
          const binary = atob(typeof file["content"] === "string" ? file["content"] : "");
          const bytes = Uint8Array.from(binary, (character) => character.charCodeAt(0));
          if (bytes.includes(0)) throw new Error("binary");
          content = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
        } catch {
          return refuse("GITHUB_NOT_TEXT", "That file is not text.");
        }
        return {
          file: {
            path: typeof file["path"] === "string" ? file["path"] : path,
            size,
            content,
            url: typeof file["html_url"] === "string" ? file["html_url"] : null,
          },
        };
      },
    ),
  ]);
}

/**
 * The GitHub plugin: a component node and the tools it hands over.
 *
 * Registered through the same public plugin API as anyone's plugin. The component
 * does no work of its own; wiring its `tools` output into an agent step is what
 * lets that step read GitHub.
 */
export function createGitHubPlugin(options: GitHubPluginOptions = {}): HarnessPlugin {
  const tools = createGitHubTools(options);
  return {
    manifest: {
      id: GITHUB_PLUGIN_ID,
      name: "GitHub",
      version: "1",
      apiVersion: PLUGIN_API_VERSION,
      capabilities: [{ id: "network:https" }],
    },
    activate(context) {
      for (const adapter of tools) context.tools.register(adapter);
      context.nodes.register({
        manifest: {
          type: GITHUB_COMPONENT_NODE_TYPE,
          version: "1",
          title: "GitHub",
          description:
            "Lets the agent steps it is connected to read GitHub: repositories, issues, pull requests and files.",
          inputs: {},
          outputs: {
            tools: { schema: { type: "array", items: { type: "string" } } },
          },
          configSchema: { type: "object", properties: {}, additionalProperties: false },
          behavior: COMPONENT,
        },
        execute: () => ({ outputs: { tools: tools.map((adapter) => adapter.manifest.id) } }),
      });
    },
  };
}

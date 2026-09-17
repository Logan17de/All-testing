import { describe, expect, it } from "vitest";

import type {
  AdapterInvocationContext,
  JsonObject,
  NodeDefinition,
  ToolAdapter,
} from "@zet-harness/plugin-api";

import { GITHUB_TOOL_IDS, createGitHubPlugin, createGitHubTools } from "./github-plugin.js";

interface Seen {
  readonly url: string;
  readonly headers: Record<string, string>;
}

function context(): AdapterInvocationContext {
  return {
    runId: "run-test",
    opIndex: 0,
    iteration: 0,
    attempt: 1,
    logicalEffectId: "effect-test",
    signal: new AbortController().signal,
    retryBudget: {
      maxAttempts: 1,
      repeatAuthorized: false,
      usedAttempts: 1,
      remainingAttempts: 0,
      reportInternalRetries: () => 0,
    },
  };
}

function github(
  answer: (url: string) => { status?: number; body?: unknown; headers?: Record<string, string> },
  token?: string,
): { readonly tools: readonly ToolAdapter[]; readonly seen: Seen[] } {
  const seen: Seen[] = [];
  const tools = createGitHubTools({
    ...(token === undefined ? {} : { token: () => token }),
    fetch: (input, init) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
      seen.push({ url, headers: { ...(init?.headers as Record<string, string>) } });
      const { status = 200, body = {}, headers = {} } = answer(url);
      return Promise.resolve(
        new Response(JSON.stringify(body), {
          status,
          headers: { "content-type": "application/json", ...headers },
        }),
      );
    },
  });
  return { tools, seen };
}

async function call(
  tools: readonly ToolAdapter[],
  id: string,
  input: JsonObject,
): Promise<Record<string, unknown>> {
  const tool = tools.find((candidate) => candidate.manifest.id === id);
  if (tool === undefined) throw new Error(`No tool ${id}.`);
  return (await tool.invoke(input, context())).value as Record<string, unknown>;
}

describe("the GitHub tools", () => {
  it("describes a repository, sending a token only when there is one", async () => {
    const answered = {
      full_name: "acme/rockets",
      description: "Rockets.",
      default_branch: "main",
      stargazers_count: 12,
      open_issues_count: 3,
      private: false,
      html_url: "https://github.com/acme/rockets",
      node_id: "R_kgDO",
    };
    const anonymous = github(() => ({ body: answered }));
    expect(
      await call(anonymous.tools, GITHUB_TOOL_IDS.repository, { owner: "acme", repo: "rockets" }),
    ).toEqual({
      ok: true,
      repository: {
        name: "acme/rockets",
        description: "Rockets.",
        defaultBranch: "main",
        stars: 12,
        openIssues: 3,
        private: false,
        url: "https://github.com/acme/rockets",
      },
    });
    expect(anonymous.seen[0]?.url).toBe("https://api.github.com/repos/acme/rockets");
    expect(anonymous.seen[0]?.headers["authorization"]).toBeUndefined();

    const signedIn = github(() => ({ body: answered }), "ghp_test");
    await call(signedIn.tools, GITHUB_TOOL_IDS.repository, { owner: "acme", repo: "rockets" });
    expect(signedIn.seen[0]?.headers["authorization"]).toBe("Bearer ghp_test");

    // A token never goes in the clear to another machine.
    const seen: string[] = [];
    const plain = createGitHubTools({
      apiBaseUrl: "http://github.example.com/api/v3",
      token: () => "ghp_test",
      fetch: (_input, init) => {
        seen.push((init?.headers as Record<string, string>)["authorization"] ?? "none");
        return Promise.resolve(new Response(JSON.stringify(answered), { status: 200 }));
      },
    });
    await call(plain, GITHUB_TOOL_IDS.repository, { owner: "acme", repo: "rockets" });
    expect(seen).toEqual(["none"]);
  });

  it("lists issues without the pull requests GitHub mixes in", async () => {
    const { tools, seen } = github(() => ({
      body: [
        {
          number: 7,
          title: "Engine stalls",
          state: "open",
          user: { login: "ada" },
          labels: [{ name: "bug" }],
          comments: 2,
          html_url: "https://github.com/acme/rockets/issues/7",
        },
        { number: 8, title: "Fix engine", pull_request: {}, user: { login: "bob" } },
      ],
    }));
    expect(
      await call(tools, GITHUB_TOOL_IDS.issues, { owner: "acme", repo: "rockets", limit: 500 }),
    ).toEqual({
      ok: true,
      issues: [
        {
          number: 7,
          title: "Engine stalls",
          state: "open",
          author: "ada",
          labels: ["bug"],
          comments: 2,
          url: "https://github.com/acme/rockets/issues/7",
        },
      ],
    });
    // The limit is capped rather than passed through.
    expect(seen[0]?.url).toBe(
      "https://api.github.com/repos/acme/rockets/issues?state=open&per_page=30",
    );
  });

  it("reads a text file, and refuses folders, binaries and paths that climb out", async () => {
    const content = btoa("# Rockets\n");
    const { tools, seen } = github((url) =>
      url.includes("README")
        ? {
            body: {
              type: "file",
              encoding: "base64",
              content,
              size: 10,
              path: "README.md",
              html_url: "https://github.com/acme/rockets/blob/main/README.md",
            },
          }
        : url.includes("docs")
          ? { body: [{ name: "a.md" }] }
          : {
              body: {
                type: "file",
                encoding: "base64",
                content: btoa(String.fromCharCode(0, 1, 2)),
                size: 3,
              },
            },
    );

    expect(
      await call(tools, GITHUB_TOOL_IDS.file, {
        owner: "acme",
        repo: "rockets",
        path: "README.md",
        ref: "v1.0",
      }),
    ).toMatchObject({ ok: true, file: { path: "README.md", content: "# Rockets\n" } });
    expect(seen[0]?.url).toBe(
      "https://api.github.com/repos/acme/rockets/contents/README.md?ref=v1.0",
    );

    expect(
      await call(tools, GITHUB_TOOL_IDS.file, { owner: "acme", repo: "rockets", path: "docs" }),
    ).toMatchObject({ ok: false, error: { code: "GITHUB_NOT_A_FILE" } });
    expect(
      await call(tools, GITHUB_TOOL_IDS.file, { owner: "acme", repo: "rockets", path: "logo.png" }),
    ).toMatchObject({ ok: false, error: { code: "GITHUB_NOT_TEXT" } });

    const before = seen.length;
    expect(
      await call(tools, GITHUB_TOOL_IDS.file, {
        owner: "acme",
        repo: "rockets",
        path: "../../users/secret",
      }),
    ).toMatchObject({ ok: false, error: { code: "GITHUB_INPUT_INVALID" } });
    expect(seen.length).toBe(before);
  });

  it("refuses names that are not GitHub's before asking GitHub anything", async () => {
    const { tools, seen } = github(() => ({ body: {} }));
    for (const input of [
      { owner: "acme/x", repo: "rockets" },
      { owner: "acme", repo: ".." },
      { owner: "", repo: "rockets" },
      { owner: "acme" },
    ]) {
      expect(await call(tools, GITHUB_TOOL_IDS.repository, input)).toMatchObject({
        ok: false,
        error: { code: "GITHUB_INPUT_INVALID" },
      });
    }
    expect(seen).toHaveLength(0);
  });

  it("says why GitHub said no", async () => {
    const cases: [number, Record<string, string>, string][] = [
      [404, {}, "GITHUB_NOT_FOUND"],
      [403, { "x-ratelimit-remaining": "0" }, "GITHUB_RATE_LIMITED"],
      [403, {}, "GITHUB_FORBIDDEN"],
      [401, {}, "GITHUB_UNAUTHORIZED"],
      [500, {}, "GITHUB_ERROR"],
    ];
    for (const [status, headers, code] of cases) {
      const { tools } = github(() => ({ status, headers, body: { message: "no" } }));
      expect(
        await call(tools, GITHUB_TOOL_IDS.issue, { owner: "acme", repo: "rockets", number: 1 }),
      ).toMatchObject({ ok: false, error: { code } });
    }

    const unreachable = createGitHubTools({ fetch: () => Promise.reject(new Error("offline")) });
    expect(
      await call(unreachable, GITHUB_TOOL_IDS.pulls, { owner: "acme", repo: "rockets" }),
    ).toMatchObject({ ok: false, error: { code: "GITHUB_UNREACHABLE" } });
  });
});

describe("the GitHub component", () => {
  it("registers the tools and a component whose output names them", async () => {
    const registered: { tools: string[]; nodes: { type: string; run: () => unknown }[] } = {
      tools: [],
      nodes: [],
    };
    const plugin = createGitHubPlugin();
    await plugin.activate({
      nodes: {
        register: (definition: NodeDefinition) => {
          registered.nodes.push({
            type: definition.manifest.type,
            run: () =>
              (definition.execute as (input: unknown, context: unknown) => unknown)({}, {}),
          });
        },
      },
      tools: {
        register: (adapter: ToolAdapter) => {
          registered.tools.push(adapter.manifest.id);
        },
      },
      models: { register: () => undefined },
    } as never);

    expect(registered.tools).toEqual(Object.values(GITHUB_TOOL_IDS));
    expect(registered.nodes.map((node) => node.type)).toEqual(["github.component"]);
    expect(registered.nodes[0]?.run()).toEqual({ outputs: { tools: registered.tools } });
  });
});

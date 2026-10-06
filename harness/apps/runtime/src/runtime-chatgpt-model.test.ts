import { describe, expect, it, vi } from "vitest";
import type { AdapterInvocationContext, ModelRequest } from "@zet-harness/plugin-api";
import { createChatGPTPlanModelAdapter, listChatGPTPlanModels } from "./runtime-chatgpt-model.js";
const context = (signal = new AbortController().signal): AdapterInvocationContext => ({
  runId: "run",
  opIndex: 0,
  iteration: 0,
  attempt: 1,
  logicalEffectId: "effect",
  signal,
  retryBudget: {
    maxAttempts: 1,
    repeatAuthorized: false,
    usedAttempts: 1,
    remainingAttempts: 0,
    reportInternalRetries: () => 1,
  },
});
const request: ModelRequest = {
  messages: [
    { role: "system", parts: [{ kind: "text", text: "instructions" }] },
    { role: "user", parts: [{ kind: "text", text: "query" }] },
  ],
  maxOutputTokens: 100,
};
const completed = (
  output: unknown[],
  usage: unknown = { input_tokens: 5, output_tokens: 2, total_tokens: 7 },
) => ({
  type: "response.completed",
  response: { id: "resp-test", status: "completed", output, usage },
});
const message = {
  type: "message",
  role: "assistant",
  content: [{ type: "output_text", text: "answer" }],
};
function setup(events: unknown[]) {
  const fetch = vi.fn<typeof globalThis.fetch>(() =>
    Promise.resolve(
      new Response(events.map((value) => `data: ${JSON.stringify(value)}\r\n\r\n`).join(""), {
        headers: { "Content-Type": "text/event-stream" },
      }),
    ),
  );
  const accessToken = vi.fn(() => Promise.resolve("volatile-secret"));
  return {
    fetch,
    accessToken,
    adapter: createChatGPTPlanModelAdapter({
      id: "chatgpt.fixture",
      model: "gpt-test",
      accessToken,
      fetch,
    }),
  };
}
describe("native ChatGPT Responses inference adapter (mock provider)", () => {
  it("streams text and completed measured results without unsupported plan parameters", async () => {
    const f = setup([
      { type: "response.output_text.delta", delta: "answer" },
      completed([message]),
    ]);
    const events = [];
    for await (const value of f.adapter.stream!(request, context())) events.push(value);
    expect(events.map((value) => value.type)).toEqual(["text-delta", "usage", "completed"]);
    const result = events.at(-1)!;
    expect(result.type === "completed" && result.result.usage).toEqual({
      inputTokens: 5,
      outputTokens: 2,
      totalTokens: 7,
    });
    const body = JSON.parse(f.fetch.mock.calls[0]![1]!.body as string) as Record<string, unknown>;
    expect(body.store).toBe(false);
    expect(body.stream).toBe(true);
    expect(body.input).toEqual([
      { role: "developer", content: "instructions" },
      { role: "user", content: "query" },
    ]);
    expect(body).not.toHaveProperty("max_output_tokens");
    expect(body).not.toHaveProperty("previous_response_id");
    expect(f.fetch.mock.calls[0]![0]).toBe("https://api.openai.com/v1/responses");
  });
  it("namespaces only offered tools and returns decoded calls for native execution after completion", async () => {
    const f = setup([]);
    f.fetch.mockImplementationOnce((_url, init) => {
      const body = JSON.parse(init!.body as string) as {
        tools: { type: string; name: string; tools: { name: string }[] }[];
      };
      expect(body.tools[0]!.type).toBe("namespace");
      expect(body.tools[0]!.name).toBe("harness");
      const name = body.tools[0]!.tools[0]!.name;
      return Promise.resolve(
        new Response(
          `data: ${JSON.stringify(completed([{ type: "function_call", namespace: "harness", name, call_id: "call_1", arguments: '{"path":"README.md"}' }]))}\n\n`,
          { headers: { "Content-Type": "text/event-stream" } },
        ),
      );
    });
    const result = await f.adapter.generate(
      { ...request, tools: [{ name: "harness.fs.read", inputSchema: { type: "object" } }] },
      context(),
    );
    expect(result.finishReason).toBe("tool-calls");
    expect(result.message.parts).toEqual([
      {
        kind: "tool-call",
        callId: "call_1",
        name: "harness.fs.read",
        arguments: { path: "README.md" },
      },
    ]);
  });
  it.each(["local_shell_call", "mcp_call", "computer_call", "web_search_call"])(
    "rejects unsolicited hosted %s",
    async (type) => {
      const f = setup([completed([{ type }])]);
      await expect(f.adapter.generate(request, context())).rejects.toThrow(
        "MODEL_RESPONSE_INVALID",
      );
    },
  );
  it("rejects unoffered function names and wrong namespaces", async () => {
    const f = setup([
      completed([
        {
          type: "function_call",
          namespace: "harness",
          name: "unoffered",
          call_id: "call_1",
          arguments: "{}",
        },
      ]),
    ]);
    await expect(f.adapter.generate(request, context())).rejects.toThrow("MODEL_RESPONSE_INVALID");
  });
  it.each([{ output_tokens: 101 }, { input_tokens: 1 }, { output_tokens: -1 }])(
    "gates output budget without executing tools when usage invalid/exceeded %j",
    async (usage) => {
      const f = setup([completed([message], usage)]);
      await expect(f.adapter.generate(request, context())).rejects.toThrow(
        /MODEL_RESPONSE_(?:LIMIT|INVALID)/u,
      );
    },
  );
  it("requires terminal completion and never retries denied access", async () => {
    const f = setup([{ type: "response.output_text.delta", delta: "partial" }]);
    await expect(f.adapter.generate(request, context())).rejects.toThrow("MODEL_STREAM_TRUNCATED");
    f.fetch.mockResolvedValueOnce(new Response("private", { status: 403 }));
    await expect(f.adapter.generate(request, context())).rejects.toThrow("MODEL_HTTP_ERROR");
    expect(f.fetch).toHaveBeenCalledTimes(2);
  });
  it("rejects unsupported vision/options before credential access", async () => {
    const f = setup([]);
    await expect(
      f.adapter.generate({ ...request, options: { openai: { temperature: 1 } } }, context()),
    ).rejects.toThrow("MODEL_REQUEST_UNSUPPORTED");
    expect(f.accessToken).not.toHaveBeenCalled();
  });
  it("cancels pending shared credential lookup without waiting for it", async () => {
    const f = setup([]);
    f.accessToken.mockReturnValueOnce(new Promise(() => undefined));
    const abort = new AbortController();
    const pending = f.adapter.generate(request, context(abort.signal));
    abort.abort(new Error("user-cancel"));
    await expect(pending).rejects.toThrow("user-cancel");
    expect(f.fetch).not.toHaveBeenCalled();
  });
  it("lists only authenticated visible models in server order", async () => {
    const fetch = vi.fn<typeof globalThis.fetch>(() =>
      Promise.resolve(
        Response.json({
          models: [
            { slug: "gpt-b", display_name: "B", visibility: "list" },
            { slug: "hidden", display_name: "Hidden", visibility: "hidden" },
            { slug: "gpt-a", display_name: "A", visibility: "list" },
          ],
        }),
      ),
    );
    expect(
      await listChatGPTPlanModels({ accessToken: () => Promise.resolve("secret"), fetch }),
    ).toEqual([
      { slug: "gpt-b", displayName: "B" },
      { slug: "gpt-a", displayName: "A" },
    ]);
    expect(fetch.mock.calls[0]![0]).toBe("https://api.openai.com/v1/models");
  });
});
describe("host-authorized image input (mock provider; no desktop bridge)", () => {
  const png = Buffer.from(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Wl6pAAAAABJRU5ErkJggg==",
    "base64",
  );
  const imageRequest = (
    role: "user" | "assistant" = "user",
    artifactRef = "artifact:fixture",
    mediaType = "image/png",
  ): ModelRequest => ({
    messages: [
      {
        role,
        parts: [
          { kind: "text", text: "Inspect this user-selected image." },
          { kind: "image", artifactRef, mediaType },
        ],
      },
    ],
    maxOutputTokens: 100,
  });
  function imageSetup(
    resolveImage: NonNullable<Parameters<typeof createChatGPTPlanModelAdapter>[0]["resolveImage"]>,
  ) {
    const f = setup([completed([message])]);
    return {
      ...f,
      adapter: createChatGPTPlanModelAdapter({
        id: "chatgpt.fixture",
        model: "gpt-test",
        accessToken: f.accessToken,
        fetch: f.fetch,
        resolveImage,
      }),
    };
  }
  it("preserves original invocation identity and refuses revocation during credential refresh", async () => {
    const f = setup([completed([message])]);
    const original = context();
    let authorized = true;
    let release!: (value: string) => void;
    const accessToken = vi.fn(
      () =>
        new Promise<string>((resolve) => {
          release = resolve;
        }),
    );
    const validate = vi.fn((received: AdapterInvocationContext) => {
      expect(received).toBe(original);
      if (!authorized) throw new Error("private revoked authority");
    });
    const resolver = vi.fn((_ref: string, received: AdapterInvocationContext) => {
      expect(received).toBe(original);
      return Promise.resolve({ bytes: png, mediaType: "image/png" as const });
    });
    const adapter = createChatGPTPlanModelAdapter({
      id: "fixture",
      model: "gpt-test",
      accessToken,
      fetch: f.fetch,
      resolveImage: resolver,
      validateImageAuthority: validate,
    });
    const pending = adapter.generate(imageRequest(), original);
    await vi.waitFor(() => expect(accessToken).toHaveBeenCalledOnce());
    authorized = false;
    release("volatile-secret");
    await expect(pending).rejects.toMatchObject({ code: "MODEL_REQUEST_UNSUPPORTED" });
    expect(validate).toHaveBeenCalledTimes(2);
    expect(f.fetch).not.toHaveBeenCalled();
  });
  it("accepts host-authorized image bytes above the old thumbnail limit within the 8MiB cap", async () => {
    const bytes = Buffer.concat([png, Buffer.alloc(600_000)]);
    const f = imageSetup(() => Promise.resolve({ bytes, mediaType: "image/png" }));
    await f.adapter.generate(imageRequest(), context());
    expect(f.fetch).toHaveBeenCalledOnce();
  });
  it("encodes only trusted user image bytes as public input_image without persisting the artifact ref", async () => {
    const resolver = vi.fn<
      NonNullable<Parameters<typeof createChatGPTPlanModelAdapter>[0]["resolveImage"]>
    >(() => Promise.resolve({ bytes: png, mediaType: "image/png" as const }));
    const f = imageSetup(resolver);
    expect(f.adapter.manifest.features.vision).toBe(true);
    await f.adapter.generate(imageRequest(), context());
    expect(resolver.mock.calls[0]?.[0]).toBe("artifact:fixture");
    const body = JSON.parse(f.fetch.mock.calls[0]![1]!.body as string) as {
      input: unknown[];
      store: boolean;
    };
    expect(body.store).toBe(false);
    expect(body.input).toEqual([
      { role: "user", content: "Inspect this user-selected image." },
      {
        role: "user",
        content: [
          {
            type: "input_image",
            image_url: `data:image/png;base64,${png.toString("base64")}`,
            detail: "auto",
          },
        ],
      },
    ]);
    expect(JSON.stringify(body)).not.toContain("artifact:fixture");
  });
  it("default no resolver refuses images before credential lookup or provider fetch", async () => {
    const f = setup([completed([message])]);
    expect(f.adapter.manifest.features.vision).toBe(false);
    await expect(f.adapter.generate(imageRequest(), context())).rejects.toMatchObject({
      code: "MODEL_REQUEST_UNSUPPORTED",
    });
    expect(f.accessToken).not.toHaveBeenCalled();
    expect(f.fetch).not.toHaveBeenCalled();
  });
  it("rejects non-user images, URLs, paths and unsupported media before artifact lookup", async () => {
    const resolver = vi.fn<
      NonNullable<Parameters<typeof createChatGPTPlanModelAdapter>[0]["resolveImage"]>
    >(() => Promise.resolve({ bytes: png, mediaType: "image/png" as const }));
    const f = imageSetup(resolver);
    for (const req of [
      imageRequest("assistant"),
      imageRequest("user", "https://example.invalid/image"),
      imageRequest("user", "../file.png"),
      imageRequest("user", "C:\\file.png"),
      imageRequest("user", "fixture", "image/svg+xml"),
    ])
      await expect(f.adapter.generate(req, context())).rejects.toMatchObject({
        code: "MODEL_REQUEST_UNSUPPORTED",
      });
    expect(resolver).not.toHaveBeenCalled();
    expect(f.fetch).not.toHaveBeenCalled();
  });
  it("rejects MIME/magic mismatch and limits raw bytes before base64/provider submission", async () => {
    for (const bytes of [Buffer.from("not an image"), Buffer.alloc(8_388_609)]) {
      const f = imageSetup(() => Promise.resolve({ bytes, mediaType: "image/png" }));
      await expect(f.adapter.generate(imageRequest(), context())).rejects.toHaveProperty("code");
      expect(f.fetch).not.toHaveBeenCalled();
      expect(f.accessToken).not.toHaveBeenCalled();
    }
    const f = imageSetup(() => Promise.resolve({ bytes: png, mediaType: "image/jpeg" }));
    await expect(f.adapter.generate(imageRequest(), context())).rejects.toMatchObject({
      code: "MODEL_REQUEST_UNSUPPORTED",
    });
    expect(f.fetch).not.toHaveBeenCalled();
  });
  it("supports bounded JPEG/WebP signatures and refuses malformed RIFF lengths", async () => {
    const webp = Buffer.alloc(20);
    webp.write("RIFF", 0);
    webp.writeUInt32LE(12, 4);
    webp.write("WEBPVP8 ", 8);
    for (const [mediaType, bytes] of [
      ["image/jpeg", Buffer.from([255, 216, 255, 224, 255, 217])],
      ["image/webp", webp],
    ] as const) {
      const f = imageSetup(() => Promise.resolve({ bytes, mediaType }));
      await f.adapter.generate(imageRequest("user", "fixture", mediaType), context());
      expect(f.fetch).toHaveBeenCalledTimes(1);
    }
    webp.writeUInt32LE(0, 4);
    const f = imageSetup(() => Promise.resolve({ bytes: webp, mediaType: "image/webp" }));
    await expect(
      f.adapter.generate(imageRequest("user", "fixture", "image/webp"), context()),
    ).rejects.toMatchObject({ code: "MODEL_REQUEST_UNSUPPORTED" });
  });
  it("bounds multiple images and aborts a noncooperative resolver without leaking its error", async () => {
    const f = imageSetup(() => Promise.resolve({ bytes: png, mediaType: "image/png" }));
    const part = { kind: "image" as const, artifactRef: "fixture", mediaType: "image/png" };
    await expect(
      f.adapter.generate({ messages: [{ role: "user", parts: Array(5).fill(part) }] }, context()),
    ).rejects.toMatchObject({ code: "MODEL_RESPONSE_LIMIT" });
    expect(f.fetch).not.toHaveBeenCalled();
    const controller = new AbortController();
    const hanging = imageSetup(() => new Promise(() => {}));
    const pending = hanging.adapter.generate(imageRequest(), context(controller.signal));
    controller.abort(new Error("fixture cancellation"));
    await expect(pending).rejects.toThrow("fixture cancellation");
    expect(hanging.fetch).not.toHaveBeenCalled();
    const denied = imageSetup(() => Promise.reject(new Error("private resolver error")));
    await expect(denied.adapter.generate(imageRequest(), context())).rejects.toMatchObject({
      code: "MODEL_REQUEST_UNSUPPORTED",
    });
  });
});
describe("opaque encrypted reasoning state (mock Responses)", () => {
  const scope = "a".repeat(64);
  const reasoning = {
    type: "reasoning",
    id: "rs_fixture",
    encrypted_content: "opaque-fixture-ciphertext",
    summary: [{ type: "summary_text", text: "not retained" }],
  };
  function stateSetup(events: unknown[], stateScope = scope, model = "gpt-test") {
    const f = setup(events);
    return {
      ...f,
      adapter: createChatGPTPlanModelAdapter({
        id: "chatgpt.fixture",
        model,
        stateScope,
        accessToken: f.accessToken,
        fetch: f.fetch,
      }),
    };
  }
  it("preserves only opaque encrypted item in output order and replays after JSON reload", async () => {
    const first = stateSetup([completed([reasoning, message])]);
    const output = await first.adapter.generate(request, context());
    expect(output.message.parts[0]).toEqual({
      kind: "provider-state",
      provider: "openai-responses",
      model: "gpt-test",
      scope,
      id: "rs_fixture",
      encryptedContent: "opaque-fixture-ciphertext",
    });
    expect(JSON.stringify(output)).not.toContain("not retained");
    const persisted = JSON.parse(JSON.stringify(output.message)) as typeof output.message;
    const resumed = stateSetup([completed([message])]);
    await resumed.adapter.generate(
      {
        messages: [
          ...request.messages,
          persisted,
          { role: "user", parts: [{ kind: "text", text: "continue" }] },
        ],
      },
      context(),
    );
    const body = JSON.parse(resumed.fetch.mock.calls[0]![1]!.body as string) as {
      input: unknown[];
    };
    expect(body.input[2]).toEqual({
      type: "reasoning",
      id: "rs_fixture",
      encrypted_content: "opaque-fixture-ciphertext",
      summary: [],
    });
    expect(JSON.stringify(body)).not.toContain(scope);
  });
  it("refuses account/model/provider mismatch and user-injected state before credentials", async () => {
    const output = await stateSetup([completed([reasoning])]).adapter.generate(request, context());
    for (const f of [stateSetup([], "b".repeat(64)), stateSetup([], scope, "another-model")]) {
      await expect(
        f.adapter.generate({ messages: [output.message] }, context()),
      ).rejects.toMatchObject({ code: "MODEL_REQUEST_UNSUPPORTED" });
      expect(f.accessToken).not.toHaveBeenCalled();
      expect(f.fetch).not.toHaveBeenCalled();
    }
    const f = stateSetup([]);
    await expect(
      f.adapter.generate({ messages: [{ ...output.message, role: "user" }] }, context()),
    ).rejects.toMatchObject({ code: "MODEL_REQUEST_UNSUPPORTED" });
  });
  it("fails closed for absent scope, missing ciphertext, duplicate IDs and oversized state", async () => {
    await expect(
      setup([completed([reasoning])]).adapter.generate(request, context()),
    ).rejects.toMatchObject({ code: "MODEL_RESPONSE_INVALID" });
    for (const items of [
      [{ ...reasoning, encrypted_content: undefined }],
      [reasoning, reasoning],
      [{ ...reasoning, encrypted_content: "x".repeat(65_537) }],
    ])
      await expect(
        stateSetup([completed(items)]).adapter.generate(request, context()),
      ).rejects.toHaveProperty("code");
  });
});
it("replays encrypted reasoning before its tool call and corresponding result across a persisted step", async () => {
  const scope = "c".repeat(64);
  const f = setup([]);
  let encodedName = "";
  f.fetch.mockImplementationOnce((_url, init) => {
    const body = JSON.parse(init!.body as string) as { tools: { tools: { name: string }[] }[] };
    encodedName = body.tools[0]!.tools[0]!.name;
    return Promise.resolve(
      new Response(
        `data: ${JSON.stringify(
          completed([
            {
              type: "reasoning",
              id: "rs_tool",
              encrypted_content: "opaque-tool-state",
              summary: [],
            },
            {
              type: "function_call",
              namespace: "harness",
              name: encodedName,
              call_id: "call_state",
              arguments: "{}",
            },
          ]),
        )}\n\n`,
        { headers: { "Content-Type": "text/event-stream" } },
      ),
    );
  });
  const options = {
    id: "chatgpt.fixture",
    model: "gpt-test",
    stateScope: scope,
    accessToken: f.accessToken,
    fetch: f.fetch,
  };
  const first = await createChatGPTPlanModelAdapter(options).generate(
    { ...request, tools: [{ name: "harness.fs.list", inputSchema: { type: "object" } }] },
    context(),
  );
  const reloaded = JSON.parse(JSON.stringify(first.message)) as typeof first.message;
  f.fetch.mockImplementationOnce(() =>
    Promise.resolve(
      new Response(`data: ${JSON.stringify(completed([message]))}\n\n`, {
        headers: { "Content-Type": "text/event-stream" },
      }),
    ),
  );
  await createChatGPTPlanModelAdapter(options).generate(
    {
      messages: [
        ...request.messages,
        reloaded,
        {
          role: "tool",
          parts: [{ kind: "tool-result", callId: "call_state", value: { entries: [] } }],
        },
      ],
    },
    context(),
  );
  const body = JSON.parse(f.fetch.mock.calls[1]![1]!.body as string) as {
    input: { type?: string; call_id?: string }[];
  };
  expect(body.input.slice(2).map((item) => item.type)).toEqual([
    "reasoning",
    "function_call",
    "function_call_output",
  ]);
  expect(body.input[3]?.call_id).toBe("call_state");
  expect(body.input[4]?.call_id).toBe("call_state");
});

it("allows only explicit incompatible state omission, retaining call/result order and safe count", async () => {
  const f = setup([completed([message])]);
  const adapter = createChatGPTPlanModelAdapter({
    id: "chatgpt.fixture",
    model: "gpt-test",
    stateScope: "b".repeat(64),
    accessToken: f.accessToken,
    fetch: f.fetch,
  });
  const result = await adapter.generate(
    {
      providerStatePolicy: "omit-incompatible",
      messages: [
        {
          role: "assistant",
          parts: [
            {
              kind: "provider-state",
              provider: "openai-responses",
              model: "gpt-test",
              scope: "a".repeat(64),
              id: "rs_old",
              encryptedContent: "opaque-old",
            },
            { kind: "tool-call", callId: "old-call", name: "harness.fs.list", arguments: {} },
          ],
        },
        {
          role: "tool",
          parts: [{ kind: "tool-result", callId: "old-call", value: { entries: [] } }],
        },
      ],
    },
    context(),
  );
  expect(result.droppedProviderStateCount).toBe(1);
  const body = JSON.parse(f.fetch.mock.calls[0]![1]!.body as string) as {
    input: { type?: string }[];
  };
  expect(JSON.stringify(body)).not.toContain("opaque-old");
  expect(body.input.slice(1).map((item) => item.type)).toEqual([
    "function_call",
    "function_call_output",
  ]);
});

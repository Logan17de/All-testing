import type { ToolAdapter, JsonObject, AdapterInvocationContext } from "@zet-harness/plugin-api";
import type { RuntimeDesktopController } from "./runtime-desktop-http.js";
import type { DesktopAction } from "./runtime-desktop-session.js";
import type {
  CodingImageAuthority,
  RuntimeCodingImageStore,
} from "./runtime-coding-image-store.js";

/** No model tool can arm a task, forge a run/destination, or bypass an individual human decision. */
export function createRuntimeCodingDesktopTools(options: {
  controller: RuntimeDesktopController;
  authority: CodingImageAuthority;
  imageStore: RuntimeCodingImageStore;
}): readonly ToolAdapter[] {
  const authority = Object.freeze({ ...options.authority });
  const generation = authority.desktopGeneration;
  const status = options.controller.snapshot();
  if (
    status.state !== "armed" ||
    status.generation !== generation ||
    !options.imageStore.authorized(authority)
  )
    return [];
  return (["inventory", "capture", "input", "share"] as const).map((operation): ToolAdapter => {
    const id = `harness.desktop.${operation}`;
    function authorized(context: AdapterInvocationContext): boolean {
      const current = options.controller.snapshot();
      return (
        !context.signal.aborted &&
        context.runId === authority.runId &&
        context.toolScope?.includes(id) === true &&
        current.state === "armed" &&
        current.generation === generation &&
        options.imageStore.authorized(authority)
      );
    }
    return Object.freeze<ToolAdapter>({
      manifest: {
        id,
        version: "1",
        title: `Scoped desktop ${operation}`,
        description:
          operation === "share"
            ? "Request separate human consent to send one local screenshot only to this exact turn/session/model/account. Bounded reuse expires with task/run. Never returns pixels or file paths."
            : operation === "input"
              ? "Propose one exact physical input in the selected monitor/window. Each call requires human consent; never types credentials automatically."
              : "Read only the explicitly armed desktop task. Capture stays local until separate screenshot transmission consent.",
        inputSchema: {
          type: "object",
          additionalProperties: false,
          ...(operation === "input"
            ? { required: ["action"], properties: { action: { type: "object" } } }
            : operation === "share"
              ? {
                  required: ["artifactId"],
                  properties: {
                    artifactId: { type: "string" },
                    maxUses: { type: "integer", minimum: 1, maximum: 8 },
                  },
                }
              : { properties: {} }),
        },
        outputSchema: { type: "object" },
        behavior: {
          primitiveFamily: "effect",
          determinism: "nondeterministic",
          effect:
            operation === "input" || operation === "share" ? "external-write" : "external-read",
          idempotency: operation === "inventory" ? "idempotent" : "unknown",
          recovery: "manual",
          executionMode: "in-process",
          requiredCapabilities: ["desktop:task"],
        },
      },
      async invoke(input: JsonObject, context: AdapterInvocationContext) {
        context.signal.throwIfAborted();
        if (!authorized(context)) throw new Error("Desktop invocation scope expired.");
        const keys =
          operation === "input"
            ? ["action"]
            : operation === "share"
              ? ["artifactId", "maxUses"]
              : [];
        if (Object.keys(input).some((key) => !keys.includes(key)))
          throw new Error("Invalid desktop tool input.");
        const abort = () => {
          options.imageStore.revokeRun(authority.runId);
          options.controller.close();
        };
        context.signal.addEventListener("abort", abort, { once: true });
        try {
          if (operation === "inventory") {
            const state = options.controller.snapshot();
            if (!authorized(context)) throw new Error("Desktop invocation scope expired.");
            return {
              value: {
                task: state.task!,
                generation,
                monitors: state.monitors
                  .filter((monitor) => monitor.id === state.selection?.monitorId)
                  .map((monitor) => ({ ...monitor })),
                windows: state.windows
                  .filter((window) => window.id === state.selection?.windowId)
                  .map((window) => ({ ...window })),
                captureScope: "selected-monitor",
                keyboardScope: state.selection?.windowId ?? null,
              },
            };
          }
          if (operation === "capture") {
            const capture = await options.controller.session.capture(generation);
            if (!authorized(context)) throw new Error("Desktop invocation scope expired.");
            return { value: { ...capture, transmission: "local-only" } };
          }
          if (operation === "input") {
            if (!input.action || typeof input.action !== "object" || Array.isArray(input.action))
              throw new Error("Invalid desktop action.");
            await options.controller.session.act(
              generation,
              input.action as unknown as DesktopAction,
              () => authorized(context),
            );
            return { value: { requested: true } };
          }
          if (
            typeof input.artifactId !== "string" ||
            !/^[0-9a-f-]{36}$/.test(input.artifactId) ||
            (input.maxUses !== undefined &&
              (!Number.isInteger(input.maxUses) ||
                (input.maxUses as number) < 1 ||
                (input.maxUses as number) > 8))
          )
            throw new Error("Invalid screenshot lease request.");
          const part = await options.controller.approveTurnImage(
            {
              authority,
              artifactId: input.artifactId,
              maxUses: (input.maxUses as number | undefined) ?? 1,
            },
            options.imageStore,
            context.signal,
          );
          if (!authorized(context)) {
            options.imageStore.revokeRun(authority.runId);
            throw new Error("Desktop invocation scope expired.");
          }
          return {
            value: {
              image: { kind: part.kind, artifactRef: part.artifactRef, mediaType: part.mediaType },
              transmission: "approved-current-turn",
              maxUses: input.maxUses ?? 1,
            },
          };
        } catch {
          context.signal.throwIfAborted();
          throw new Error("Desktop tool request failed or refused.");
        } finally {
          context.signal.removeEventListener("abort", abort);
        }
      },
    });
  });
}

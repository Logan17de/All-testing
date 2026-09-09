import { describe, expect, it, vi } from "vitest";

import { CapabilityPermissionPolicy, PluginHost } from "@zet-harness/core";
import {
  GRAPH_JSON_VERSION,
  canonicalizeGraphJsonV1Semantics,
  checkGraphJsonV1Diagnostics,
  lowerCanonicalGraphJsonV1ToExecutionIr,
  normalizeGraphJsonV1,
  stripGraphJsonV1UiMetadata,
  type GraphJsonV1,
} from "@zet-harness/graph";
import {
  PLUGIN_API_VERSION,
  type HarnessPlugin,
  type NodeDefinition,
} from "@zet-harness/plugin-api";
import { PlainDagRun, SchedulerConcurrency } from "@zet-harness/scheduler";
import { createMockExecutionIr, createMockExecutionOp } from "@zet-harness/scheduler/testing";

type RunOptions = NonNullable<ConstructorParameters<typeof PlainDagRun>[3]>;
type Authority = NonNullable<RunOptions["capabilityAuthority"]>;

function createRun(
  options: RunOptions,
  executor: ConstructorParameters<typeof PlainDagRun>[2] = vi.fn(),
  maxAttempts = 1,
) {
  const plan = createMockExecutionIr([
    createMockExecutionOp("authority-provenance", [], {
      behavior: {
        requiredCapabilities: ["shell:run"],
        retry: { maxAttempts, backoffMs: 0 },
      },
    }),
  ]);
  const scheduler = new SchedulerConcurrency(1);
  return {
    run: new PlainDagRun(plan, scheduler.createRun(plan), executor, options),
    executor,
  };
}

function deny(): ReturnType<Authority["evaluate"]> {
  return { decision: "deny", denialReason: "not-granted" };
}

function allow(): ReturnType<Authority["evaluate"]> {
  return { decision: "allow" };
}

describe("Phase 5.8 capability authority provenance", () => {
  it("does not expose mutable policy lookup sets through ordinary reflection", () => {
    const policy = new CapabilityPermissionPolicy({
      granted: ["fs:read", "fs:write"],
      denied: ["fs:write"],
    });

    expect(Reflect.ownKeys(policy).sort()).toEqual([
      "deniedCapabilities",
      "effectiveCapabilities",
      "grantedCapabilities",
    ]);
    expect(Reflect.get(policy, "granted")).toBeUndefined();
    expect(Reflect.get(policy, "denied")).toBeUndefined();
    expect(Reflect.set(policy, "granted", new Set(["shell:run"]))).toBe(false);
    expect(Reflect.set(policy, "denied", new Set())).toBe(false);
    expect(policy.evaluate("shell:run")).toMatchObject(deny());
    expect(policy.evaluate("fs:write")).toMatchObject({
      decision: "deny",
      denialReason: "explicitly-denied",
    });
    expect(policy.allows("fs:read")).toBe(true);
  });

  it("exposes a frozen activation facade with registration but no grant surface", async () => {
    const host = new PluginHost();
    const cleanup = vi.fn();
    const plugin: HarnessPlugin = {
      manifest: {
        id: "phase-5.8.facade",
        name: "Activation facade test",
        version: "1",
        apiVersion: PLUGIN_API_VERSION,
      },
      activate(context) {
        expect(Reflect.ownKeys(context).sort()).toEqual(["models", "nodes", "onDispose", "tools"]);
        expect(Reflect.ownKeys(context.nodes)).toEqual(["register"]);
        expect(Object.isFrozen(context)).toBe(true);
        expect(Object.isFrozen(context.nodes)).toBe(true);
        expect(Reflect.set(context, "capabilityAuthority", { evaluate: allow })).toBe(false);
        expect(Reflect.set(context.nodes, "register", vi.fn())).toBe(false);
        context.onDispose(cleanup);
      },
    };

    try {
      await host.activate(plugin);
    } finally {
      await host.dispose();
    }
    expect(cleanup).toHaveBeenCalledOnce();
  });

  it("treats plugin declarations and model-proposed graph/config grants only as data", async () => {
    const host = new PluginHost();
    const forgedGrants = {
      granted: ["shell:run"],
      grantedCapabilities: ["shell:run"],
      capabilityAuthority: { decision: "allow" },
    };
    const node: NodeDefinition = {
      manifest: {
        type: "phase-5.8.external-write",
        version: "1",
        title: "External write test",
        inputs: {},
        outputs: { result: { schema: { type: "string" } } },
        configSchema: true,
        behavior: {
          primitiveFamily: "effect",
          determinism: "nondeterministic",
          effect: "external-write",
          idempotency: "unknown",
          recovery: "manual",
          executionMode: "in-process",
          requiredCapabilities: ["shell:run"],
        },
      },
      execute() {
        return { outputs: { result: "test-only" } };
      },
    };
    const plugin: HarnessPlugin = {
      manifest: {
        id: "phase-5.8.plugin",
        name: "Self-grant test",
        version: "1",
        apiVersion: PLUGIN_API_VERSION,
        capabilities: [{ id: "shell:run" }],
      },
      activate(context) {
        expect(context.config).toEqual(forgedGrants);
        expect(Reflect.has(context, "capabilityAuthority")).toBe(false);
        context.nodes.register(node);
      },
    };
    const graph: GraphJsonV1 = {
      schemaVersion: GRAPH_JSON_VERSION,
      graphId: "phase-5.8.proposal",
      revisionId: "rev-1",
      inputs: [],
      outputs: [
        { id: "result", schema: { type: "string" }, source: { nodeId: "call", port: "result" } },
      ],
      nodes: [{ id: "call", type: node.manifest.type, version: "1", config: forgedGrants }],
      edges: [],
      entrypoints: [{ id: "main", nodeId: "call" }],
      policies: { capabilities: { required: ["shell:run"] } },
    };

    try {
      await host.activate(plugin, forgedGrants);
      const denied = checkGraphJsonV1Diagnostics(graph, {
        resolver: host.nodes,
        capabilityAuthority: new CapabilityPermissionPolicy(),
      });
      expect(denied.valid).toBe(false);
      expect(denied.diagnostics).toContainEqual(
        expect.objectContaining({
          code: "GRAPH_CAPABILITY_REQUIRED_UNAVAILABLE",
          stage: "capability-policy",
          nodeId: "call",
        }),
      );

      // The same proposal is valid when the host, not the proposal, grants demand.
      const granted = new CapabilityPermissionPolicy({ granted: ["shell:run"] });
      expect(
        checkGraphJsonV1Diagnostics(graph, {
          resolver: host.nodes,
          capabilityAuthority: granted,
        }).valid,
      ).toBe(true);
      const normalized = normalizeGraphJsonV1(graph, host.nodes);
      if (!normalized.valid || normalized.normalized === undefined) {
        throw new Error("Expected a valid normalized graph after host authorization.");
      }
      const canonical = canonicalizeGraphJsonV1Semantics(
        stripGraphJsonV1UiMetadata(normalized.normalized),
      );
      const plan = lowerCanonicalGraphJsonV1ToExecutionIr(canonical, host.nodes);
      const scheduler = new SchedulerConcurrency(1);
      const executor = vi.fn();
      const run = new PlainDagRun(plan, scheduler.createRun(plan), executor, {
        capabilityAuthority: new CapabilityPermissionPolicy(),
      });

      // Compiled demand/config cannot carry the old compile-time grant into execution.
      await expect(run.execute()).rejects.toThrow("current runtime authority does not grant it");
      expect(executor).not.toHaveBeenCalled();
      expect(run.snapshot().attempts).toEqual([0]);
    } finally {
      await host.dispose();
    }
  });

  it("does not accept a grant by replacing the retained options authority", async () => {
    const options: { capabilityAuthority: Authority } = {
      capabilityAuthority: { evaluate: deny },
    };
    const { run, executor } = createRun(options);
    options.capabilityAuthority = { evaluate: allow };

    await expect(run.execute()).rejects.toThrow("current runtime authority does not grant it");
    expect(executor).not.toHaveBeenCalled();
    expect(run.snapshot().attemptBudgetUsed).toEqual([0]);
  });

  it("does not accept a grant by replacing the original authority method", async () => {
    const evaluate = vi.fn(deny);
    const authority: Authority = { evaluate };
    const { run, executor } = createRun({ capabilityAuthority: authority });
    authority.evaluate = allow;

    await expect(run.execute()).rejects.toThrow("current runtime authority does not grant it");
    expect(evaluate).toHaveBeenCalledWith("shell:run");
    expect(executor).not.toHaveBeenCalled();
  });

  it("keeps an omitted authority fail-closed after later options injection", async () => {
    const options: { capabilityAuthority?: Authority } = {};
    const { run, executor } = createRun(options);
    options.capabilityAuthority = { evaluate: allow };

    await expect(run.execute()).rejects.toThrow("current runtime authority does not grant it");
    expect(executor).not.toHaveBeenCalled();
  });

  it("pins the evaluator receiver but still honors host revocation between attempts", async () => {
    class RevocableAuthority implements Authority {
      granted = true;

      evaluate(): ReturnType<Authority["evaluate"]> {
        return this.granted ? allow() : { decision: "deny", denialReason: "explicitly-denied" };
      }
    }

    const authority = new RevocableAuthority();
    const replacement = vi.fn(allow);
    const executor = vi.fn(() => {
      authority.granted = false;
      authority.evaluate = replacement;
      throw new Error("retry after host revocation");
    });
    const { run } = createRun({ capabilityAuthority: authority }, executor, 2);

    await expect(run.execute()).rejects.toThrow("current runtime authority explicitly denies it");
    expect(executor).toHaveBeenCalledOnce();
    expect(replacement).not.toHaveBeenCalled();
    expect(run.snapshot().attempts).toEqual([1]);
    expect(run.snapshot().attemptBudgetUsed).toEqual([1]);
  });
});

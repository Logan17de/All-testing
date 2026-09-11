import type { JsonObject, NodeDefinition } from "@zet-harness/plugin-api";
import type { CapabilityPermissionPolicy, PluginHost } from "@zet-harness/core";
import type { IsolatedPlugin } from "@zet-harness/plugin-loader";

import type { RuntimeNodeExecution, RuntimeNodeExecutionResult } from "./runtime-run-dispatcher.js";

/**
 * The link between an installed plugin and an executed run.
 *
 * A plugin registering a node is only useful if the scheduler can invoke it, and
 * this is the adapter that lets it. It resolves a node type to a definition
 * contributed by some plugin, checks the host's capability policy, and runs it.
 *
 * The policy check happens here, in host code, on every invocation. A node's
 * declared `requiredCapabilities` are demand; this is where demand meets the
 * host's decision, and a node whose capabilities are not granted never runs.
 */

export type PluginExecutionDenialCode =
  "unknown-node" | "not-executable" | "capability-denied" | "execution-failed";

const DENIAL_MARKER: unique symbol = Symbol("zet-harness.plugin-execution-denied");

export class PluginExecutionError extends Error {
  readonly code: PluginExecutionDenialCode;
  readonly nodeType: string;
  /** Capabilities the node needed and did not have. */
  readonly missingCapabilities: readonly string[];

  constructor(
    code: PluginExecutionDenialCode,
    message: string,
    nodeType: string,
    missingCapabilities: readonly string[] = [],
  ) {
    super(message);
    this.name = "PluginExecutionError";
    this.code = code;
    this.nodeType = nodeType;
    this.missingCapabilities = Object.freeze([...missingCapabilities]);
    Object.defineProperty(this, DENIAL_MARKER, { value: true, enumerable: false });
  }
}

export function isPluginExecutionError(value: unknown): value is PluginExecutionError {
  return (
    typeof value === "object" &&
    value !== null &&
    (value as Record<PropertyKey, unknown>)[DENIAL_MARKER] === true
  );
}

export interface PluginNodeExecutorOptions {
  /** In-process plugins. */
  readonly host?: PluginHost;
  /** Sandboxed plugins, whose nodes are proxies into their own processes. */
  readonly sandboxes?: readonly IsolatedPlugin[];
  /**
   * Capability policy per plugin id, keyed as the loader reports it.
   *
   * A node type present in no policy is still checked: an unmapped plugin is
   * treated as granting nothing rather than as unrestricted.
   */
  readonly policies?: ReadonlyMap<string, CapabilityPermissionPolicy>;
  /** Policy for node types the host itself registered. */
  readonly hostPolicy?: CapabilityPermissionPolicy;
}

interface ResolvedNode {
  readonly definition: NodeDefinition;
  /** Plugin that contributed it, when known; undefined for host registrations. */
  readonly pluginId: string | undefined;
}

function inputsToObject(
  inputs: readonly { readonly port: string; readonly value: unknown }[],
): JsonObject {
  const record: Record<string, unknown> = {};
  for (const input of inputs) record[input.port] = input.value;
  return record as JsonObject;
}

/**
 * Build the dispatcher's execute adapter from currently loaded plugins.
 *
 * Resolution prefers in-process registrations and then sandboxes, and the first
 * match wins deterministically because both collections are searched in a fixed
 * order.
 */
export function createPluginNodeExecutor(
  options: PluginNodeExecutorOptions,
): (execution: RuntimeNodeExecution) => Promise<RuntimeNodeExecutionResult> {
  const resolve = (type: string, version: string): ResolvedNode | undefined => {
    const hostDefinition = options.host?.nodes.getDefinition(type, version);
    if (hostDefinition !== undefined) {
      const resolution = options.host?.nodes.getResolution(type, version);
      return { definition: hostDefinition, pluginId: resolution?.plugin.id };
    }

    for (const sandbox of options.sandboxes ?? []) {
      for (const node of sandbox.nodes) {
        if (node.manifest.type === type && node.manifest.version === version) {
          return { definition: node, pluginId: sandbox.pluginId };
        }
      }
    }
    return undefined;
  };

  return async (execution: RuntimeNodeExecution): Promise<RuntimeNodeExecutionResult> => {
    const type = execution.operation.type;
    const version = execution.operation.version;

    const resolved = resolve(type, version);
    if (resolved === undefined) {
      throw new PluginExecutionError(
        "unknown-node",
        `No loaded plugin provides node '${type}' version '${version}'.`,
        type,
      );
    }

    const execute = resolved.definition.execute;
    if (typeof execute !== "function") {
      // Control-structure nodes have no executor; the scheduler owns those.
      throw new PluginExecutionError(
        "not-executable",
        `Node '${type}' has no executor and cannot be dispatched.`,
        type,
      );
    }

    const required = resolved.definition.manifest.behavior.requiredCapabilities;
    if (required.length > 0) {
      const policy =
        resolved.pluginId === undefined
          ? options.hostPolicy
          : options.policies?.get(resolved.pluginId);

      // No policy means no grants. An unmapped plugin is not an unrestricted
      // one; failing open here would undo the whole capability model.
      const batch = policy?.evaluateAll(required);
      if (batch === undefined || !batch.allowed) {
        const missing = [
          ...(batch?.notGrantedCapabilities ?? required),
          ...(batch?.explicitlyDeniedCapabilities ?? []),
        ];
        throw new PluginExecutionError(
          "capability-denied",
          `Node '${type}' requires capabilities that were not granted.`,
          type,
          missing,
        );
      }
    }

    try {
      const result = await execute(
        { inputs: inputsToObject(execution.inputs), config: execution.operation.config },
        { signal: execution.signal },
      );
      return { outputs: result.outputs };
    } catch (error: unknown) {
      if (isPluginExecutionError(error)) throw error;
      throw new PluginExecutionError(
        "execution-failed",
        error instanceof Error ? error.message : `Node '${type}' failed.`,
        type,
      );
    }
  };
}

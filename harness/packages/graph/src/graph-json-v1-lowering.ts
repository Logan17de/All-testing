import type {
  NodeBehavior,
  NodeManifest,
  NodeStructuredControlContract,
} from "@zet-harness/plugin-api";

import type { CanonicalGraphCompilerSourceV1 } from "./graph-json-v1-canonical.js";
import type {
  ExecutionIrBehaviorV1,
  ExecutionIrControlDescriptorV1,
  ExecutionIrInputV1,
  ExecutionIrOpV1,
  ExecutionIrV1,
} from "./execution-ir-v1.js";
import { createExecutionIrV1, EXECUTION_IR_FORMAT } from "./execution-ir-v1.js";
import type {
  GraphDataEdgeV1,
  GraphInputBindingV1,
  GraphNodeV1,
} from "./graph-json-v1.js";
import type {
  GraphResolvedNodePinV1,
  NodeResolutionResolver,
} from "./graph-json-v1-normalization.js";

function compilerInvariant(message: string): never {
  throw new TypeError(`Execution IR lowering invariant failed: ${message}`);
}

function copyBehavior(behavior: NodeBehavior): ExecutionIrBehaviorV1 {
  return {
    primitiveFamily: behavior.primitiveFamily,
    determinism: behavior.determinism,
    effect: behavior.effect,
    idempotency: behavior.idempotency,
    recovery: behavior.recovery,
    executionMode: behavior.executionMode,
    ...(behavior.timeoutMs === undefined ? {} : { timeoutMs: behavior.timeoutMs }),
    ...(behavior.retry === undefined
      ? {}
      : {
          retry: {
            maxAttempts: behavior.retry.maxAttempts,
            ...(behavior.retry.backoffMs === undefined
              ? {}
              : { backoffMs: behavior.retry.backoffMs }),
          },
        }),
    requiredCapabilities: [...behavior.requiredCapabilities],
  };
}

/**
 * 2.22 lowers only the structured control kinds whose initial scheduler semantics
 * are part of the basic DAG milestone. Other descriptor families remain reserved
 * by Execution IR v1 and land with their later execution phases.
 */
function lowerInitialControlDescriptor(
  control: NodeStructuredControlContract | undefined,
): ExecutionIrControlDescriptorV1 | undefined {
  if (control === undefined) return undefined;

  switch (control.kind) {
    case "router":
      return {
        kind: "router",
        entry: control.entry,
        branches: [...control.branches],
      };
    case "join":
      return {
        kind: "join",
        inputs: [...control.inputs],
        output: control.output,
        mode: control.mode,
      };
    case "loop":
    case "human-interrupt":
    case "subgraph":
      return undefined;
  }
}

function assertResolvedManifest(
  node: GraphNodeV1,
  pin: GraphResolvedNodePinV1 | undefined,
  resolver: NodeResolutionResolver,
): NodeManifest {
  if (pin === undefined) {
    return compilerInvariant(`node '${node.id}' has no canonical resolved node pin.`);
  }
  if (pin.nodeId !== node.id || pin.type !== node.type || pin.version !== node.version) {
    return compilerInvariant(`node '${node.id}' does not match its canonical node pin.`);
  }

  const resolution = resolver.getResolution(node.type, node.version);
  if (resolution === undefined) {
    return compilerInvariant(`node '${node.id}' no longer resolves as '${node.type}@${node.version}'.`);
  }
  if (resolution.manifest.type !== node.type || resolution.manifest.version !== node.version) {
    return compilerInvariant(`node '${node.id}' resolved manifest identity changed during lowering.`);
  }
  if (
    resolution.plugin.id !== pin.pluginId ||
    resolution.plugin.version !== pin.pluginVersion
  ) {
    return compilerInvariant(`node '${node.id}' resolved plugin provenance changed during lowering.`);
  }

  return resolution.manifest;
}

function lowerBinding(
  binding: GraphInputBindingV1,
  graphInputIndexById: ReadonlyMap<string, number>,
): ExecutionIrInputV1 {
  switch (binding.kind) {
    case "literal":
      return {
        port: binding.port,
        source: { kind: "literal", value: binding.value },
      };
    case "graph-input": {
      const input = graphInputIndexById.get(binding.input);
      if (input === undefined) {
        return compilerInvariant(`graph input '${binding.input}' has no canonical IR index.`);
      }
      return {
        port: binding.port,
        source: { kind: "graph-input", input },
      };
    }
    case "secret":
      return {
        port: binding.port,
        source: { kind: "secret", secretRef: binding.secretRef },
      };
  }
}

function lowerDataEdgeInput(
  edge: GraphDataEdgeV1,
  opIndexByNodeId: ReadonlyMap<string, number>,
): ExecutionIrInputV1 {
  const op = opIndexByNodeId.get(edge.from.nodeId);
  if (op === undefined) {
    return compilerInvariant(`data edge '${edge.id}' source has no canonical op index.`);
  }

  return {
    port: edge.to.port,
    source: {
      kind: "op-output",
      op,
      port: edge.from.port,
    },
  };
}

/**
 * Lower already-validated, normalized, and canonical Graph JSON v1 semantics into
 * the immutable Execution IR v1 plan.
 *
 * Deterministic 2.22 rules:
 * - canonical node order defines op indexes;
 * - canonical graph-input/entrypoint order defines their index domains;
 * - every data/control edge contributes an execution dependency;
 * - data edges additionally become resolved `op-output` node inputs;
 * - control edges are retained with indexed endpoints and semantic port names;
 * - dependency indexes are deduplicated and sorted numerically;
 * - authored non-edge bindings stay ordered, followed by incoming data edges in
 *   canonical edge-id order, making multi-source aggregation sequence explicit;
 * - router and all-active join manifest contracts become IR control descriptors;
 * - loop/human/subgraph descriptors remain reserved but are not lowered here.
 *
 * This is not a user-facing validation pass. Any missing/mismatched pin, manifest,
 * or reference is a compiler invariant failure because 2.5-2.19 already proved
 * the source and 2.21 separately records the exact registry provenance.
 */
export function lowerCanonicalGraphJsonV1ToExecutionIr(
  canonical: CanonicalGraphCompilerSourceV1,
  resolver: NodeResolutionResolver,
): ExecutionIrV1 {
  const semantics = canonical.semantics;

  if (canonical.nodePins.length !== semantics.nodes.length) {
    return compilerInvariant("canonical node-pin count does not match canonical node count.");
  }

  const opIndexByNodeId = new Map(
    semantics.nodes.map((node, index) => [node.id, index] as const),
  );
  const graphInputIndexById = new Map(
    semantics.inputs.map((input, index) => [input.id, index] as const),
  );
  const entrypointIndexById = new Map(
    semantics.entrypoints.map((entrypoint, index) => [entrypoint.id, index] as const),
  );
  const pinByNodeId = new Map(canonical.nodePins.map((pin) => [pin.nodeId, pin] as const));

  const incomingDataEdges = new Map<string, GraphDataEdgeV1[]>();
  const dependencySets = semantics.nodes.map(() => new Set<number>());

  for (const edge of semantics.edges) {
    const from = opIndexByNodeId.get(edge.from.nodeId);
    const to = opIndexByNodeId.get(edge.to.nodeId);
    if (from === undefined || to === undefined) {
      return compilerInvariant(`edge '${edge.id}' has an unresolved canonical node reference.`);
    }

    dependencySets[to]?.add(from);

    if (edge.kind === "data") {
      const existing = incomingDataEdges.get(edge.to.nodeId);
      if (existing === undefined) {
        incomingDataEdges.set(edge.to.nodeId, [edge]);
      } else {
        existing.push(edge);
      }
    }
  }

  const ops: ExecutionIrOpV1[] = semantics.nodes.map((node, opIndex) => {
    const manifest = assertResolvedManifest(node, pinByNodeId.get(node.id), resolver);
    const bindingInputs = (node.bindings ?? []).map((binding) =>
      lowerBinding(binding, graphInputIndexById),
    );
    const dataInputs = (incomingDataEdges.get(node.id) ?? []).map((edge) =>
      lowerDataEdgeInput(edge, opIndexByNodeId),
    );
    const dependencies = [...(dependencySets[opIndex] ?? [])].sort((left, right) => left - right);
    const control = lowerInitialControlDescriptor(manifest.control);

    return {
      sourceNodeId: node.id,
      type: node.type,
      version: node.version,
      config: node.config,
      inputs: [...bindingInputs, ...dataInputs],
      dependencies,
      behavior: copyBehavior(manifest.behavior),
      ...(control === undefined ? {} : { control }),
    };
  });

  const graphOutputs = semantics.outputs.map((output) => {
    const op = opIndexByNodeId.get(output.source.nodeId);
    if (op === undefined) {
      return compilerInvariant(`graph output '${output.id}' has no canonical source op index.`);
    }
    return {
      id: output.id,
      source: { op, port: output.source.port },
    };
  });

  const controlEdges = semantics.edges
    .filter((edge) => edge.kind === "control")
    .map((edge) => {
      const from = opIndexByNodeId.get(edge.from.nodeId);
      const to = opIndexByNodeId.get(edge.to.nodeId);
      if (from === undefined || to === undefined) {
        return compilerInvariant(`control edge '${edge.id}' has an unresolved op index.`);
      }
      return {
        from: {
          op: from,
          ...(edge.from.port === undefined ? {} : { port: edge.from.port }),
        },
        to: {
          op: to,
          ...(edge.to.port === undefined ? {} : { port: edge.to.port }),
        },
      };
    });

  const entrypoints = semantics.entrypoints.map((entrypoint) => {
    const op = opIndexByNodeId.get(entrypoint.nodeId);
    if (op === undefined) {
      return compilerInvariant(`entrypoint '${entrypoint.id}' has no canonical op index.`);
    }
    return {
      id: entrypoint.id,
      op,
      ...(entrypoint.port === undefined ? {} : { port: entrypoint.port }),
    };
  });

  const defaultEntrypointId = semantics.options?.defaultEntrypoint;
  const defaultEntrypoint =
    defaultEntrypointId === undefined
      ? undefined
      : entrypointIndexById.get(defaultEntrypointId);
  if (defaultEntrypointId !== undefined && defaultEntrypoint === undefined) {
    return compilerInvariant(`default entrypoint '${defaultEntrypointId}' has no canonical index.`);
  }

  const capabilities = semantics.policies?.capabilities;
  const candidate: ExecutionIrV1 = {
    format: EXECUTION_IR_FORMAT,
    graphInputs: semantics.inputs.map((input) => ({
      id: input.id,
      required: input.required ?? false,
      ...(input.default === undefined ? {} : { default: input.default }),
    })),
    graphOutputs,
    ops,
    controlEdges,
    entrypoints,
    ...(defaultEntrypoint === undefined ? {} : { defaultEntrypoint }),
    policies: {
      ...(semantics.policies?.maxNodeExecutions === undefined
        ? {}
        : { maxNodeExecutions: semantics.policies.maxNodeExecutions }),
      ...(semantics.policies?.maxParallelism === undefined
        ? {}
        : { maxParallelism: semantics.policies.maxParallelism }),
      ...(semantics.policies?.maxWallTimeMs === undefined
        ? {}
        : { maxWallTimeMs: semantics.policies.maxWallTimeMs }),
      capabilities: {
        required: [...(capabilities?.required ?? [])],
        optional: [...(capabilities?.optional ?? [])],
        deny: [...(capabilities?.deny ?? [])],
      },
    },
  };

  return createExecutionIrV1(candidate);
}

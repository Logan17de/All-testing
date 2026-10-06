import type { MakerArtifact, RuntimePluginMaker } from "./runtime-plugin-maker.js";
export interface MakerExecutionReport {
  readonly executed: boolean;
  readonly passed: boolean;
  readonly mode: "required-os-sandbox";
  readonly code?: string;
  readonly stdout?: string;
  readonly stderr?: string;
}
export interface MakerOperationAuthority {
  readonly signal: AbortSignal;
  check(): void;
}
export interface PluginMakerControllerHost {
  materialize(
    artifact: MakerArtifact,
    directory: string,
    operation: MakerOperationAuthority,
  ): Promise<void>;
  /** Must recheck exact on-disk hash and use required OS sandbox; never fall back to host execution. */
  test(
    artifact: MakerArtifact,
    directory: string,
    operation: MakerOperationAuthority,
  ): Promise<MakerExecutionReport>;
  /** Must recheck all file hashes and use existing disabled-first plugin install/review broker. Never grant new capabilities. */
  enable(
    artifact: MakerArtifact,
    directory: string,
    declaredScopes: readonly string[],
    operation: MakerOperationAuthority,
  ): Promise<unknown>;
}
const deny = () => new Error("Plugin maker action denied or stale.");
function directory(value: unknown): string {
  if (
    typeof value !== "string" ||
    value.length > 200 ||
    !/^[A-Za-z0-9][A-Za-z0-9._-]*(?:\/[A-Za-z0-9][A-Za-z0-9._-]*)*$/u.test(value) ||
    value.split("/").some((p) => ["node_modules", "plugins", "dist"].includes(p))
  )
    throw deny();
  return value;
}
export function createRuntimePluginMakerController(options: {
  maker: RuntimePluginMaker;
  userAuthority: object;
  host: PluginMakerControllerHost;
  scopeGeneration?: () => number;
}) {
  const { maker, userAuthority, host } = options;
  let selected: MakerArtifact | null = null;
  let materialized: string | null = null;
  let reviewed: string | null = null;
  let report: MakerExecutionReport | null = null;
  let enabled = false;
  let generation = 0;
  let operationGeneration = 0;
  let active: AbortController | undefined;
  const invalidateOperations = () => {
    operationGeneration++;
    active?.abort();
    active = undefined;
  };
  let scopeGeneration = options.scopeGeneration?.() ?? 0;
  const syncScope = () => {
    const next = options.scopeGeneration?.() ?? 0;
    if (!Number.isSafeInteger(next) || next < 0) throw deny();
    if (next !== scopeGeneration) {
      invalidateOperations();
      scopeGeneration = next;
      selected = null;
      materialized = null;
      reviewed = null;
      report = null;
      enabled = false;
      generation++;
    }
  };
  const select = (value: MakerArtifact) => {
    invalidateOperations();
    selected = value;
    materialized = null;
    reviewed = null;
    report = null;
    enabled = false;
    generation++;
    return value;
  };
  const exact = (params: Record<string, unknown>, execution = false) => {
    const allowed = [
      "hash",
      "directory",
      "scopes",
      "confirm",
      ...(execution ? ["allowExecution"] : []),
    ];
    if (
      Object.keys(params).length !== allowed.length ||
      Object.keys(params).some((k) => !allowed.includes(k)) ||
      params.confirm !== true ||
      (execution && params.allowExecution !== true) ||
      typeof params.hash !== "string" ||
      !selected ||
      selected.hash !== params.hash
    )
      throw deny();
    const target = directory(params.directory);
    if (
      !Array.isArray(params.scopes) ||
      params.scopes.some((s) => typeof s !== "string") ||
      new Set(params.scopes).size !== params.scopes.length
    )
      throw deny();
    const scopes = params.scopes as string[];
    if (
      JSON.stringify([...scopes].sort()) !==
        JSON.stringify([...selected.requestedCapabilities].sort()) ||
      !maker.validate(selected.hash).valid
    )
      throw deny();
    return {
      artifact: selected,
      directory: target,
      scopes: Object.freeze([...scopes]),
      generation,
    };
  };
  const operation = (proof: ReturnType<typeof exact>) => {
    invalidateOperations();
    active = new AbortController();
    const signal = active.signal;
    const op = operationGeneration;
    const scope = scopeGeneration;
    return Object.freeze({
      signal,
      check() {
        signal.throwIfAborted();
        syncScope();
        if (
          op !== operationGeneration ||
          proof.generation !== generation ||
          scope !== scopeGeneration ||
          selected?.hash !== proof.artifact.hash
        )
          throw deny();
      },
    });
  };
  return Object.freeze({
    invalidateScope() {
      invalidateOperations();
      selected = null;
      materialized = null;
      reviewed = null;
      report = null;
      enabled = false;
      generation++;
      scopeGeneration = options.scopeGeneration?.() ?? 0;
    },
    snapshot() {
      syncScope();
      return Object.freeze({
        scopeGeneration,
        artifact: selected,
        reviewed: reviewed !== null,
        materialized: materialized !== null,
        test: report,
        enabled,
        notice:
          "Generated code stays quarantined until exact human review and separate approved execution. Marketplace publication is deferred.",
      });
    },
    async action(action: string, params: Record<string, unknown>): Promise<unknown> {
      syncScope();
      if (action === "scaffold") {
        if (Object.keys(params).some((k) => !["id", "name", "description", "license"].includes(k)))
          throw deny();
        return select(
          maker.scaffold(
            params as { id: string; name: string; description?: string; license?: string },
          ),
        );
      }
      if (action === "edit") {
        if (
          Object.keys(params).length !== 3 ||
          typeof params.hash !== "string" ||
          typeof params.path !== "string" ||
          typeof params.content !== "string" ||
          !selected ||
          params.hash !== selected.hash
        )
          throw deny();
        return select(maker.edit(params.hash, params.path, params.content));
      }
      if (action === "inspect" || action === "validate") {
        if (Object.keys(params).length !== 1 || typeof params.hash !== "string") throw deny();
        if (action === "inspect") {
          const value = maker.inspect(params.hash);
          return selected?.hash === value.hash ? value : select(value);
        }
        if (!selected || selected.hash !== params.hash) throw deny();
        return maker.validate(params.hash);
      }
      if (!["materialize", "review", "test", "enable"].includes(action)) throw deny();
      const proof = exact(params, action === "test" || action === "enable");
      const key = `${proof.artifact.hash}:${proof.directory}`;
      const authority = operation(proof);
      authority.check();
      if (action === "materialize") {
        await host.materialize(proof.artifact, proof.directory, authority);
        authority.check();
        syncScope();
        if (generation !== proof.generation) throw deny();
        materialized = key;
        reviewed = null;
        report = null;
        return {
          hash: proof.artifact.hash,
          directory: proof.directory,
          quarantined: true,
          enabled: false,
        };
      }
      if (materialized !== key) throw deny();
      if (action === "review") {
        maker.review(userAuthority, proof.artifact.hash, proof.scopes);
        reviewed = key;
        return { hash: proof.artifact.hash, reviewed: true, enabled: false };
      }
      if (action === "test") {
        const result = await host.test(proof.artifact, proof.directory, authority);
        authority.check();
        syncScope();
        if (generation !== proof.generation || materialized !== key) throw deny();
        if (
          !result ||
          result.mode !== "required-os-sandbox" ||
          typeof result.executed !== "boolean" ||
          typeof result.passed !== "boolean" ||
          (!result.executed && result.passed)
        )
          throw deny();
        report = Object.freeze({
          ...result,
          ...(result.stdout === undefined ? {} : { stdout: result.stdout.slice(0, 8192) }),
          ...(result.stderr === undefined ? {} : { stderr: result.stderr.slice(0, 8192) }),
        });
        return report;
      }
      if (reviewed !== key || !report?.executed || !report.passed) throw deny();
      const result = await host.enable(proof.artifact, proof.directory, proof.scopes, authority);
      authority.check();
      syncScope();
      if (generation !== proof.generation || reviewed !== key) throw deny();
      enabled = true;
      return { hash: proof.artifact.hash, enabled: true, result };
    },
  });
}
export type RuntimePluginMakerController = ReturnType<typeof createRuntimePluginMakerController>;

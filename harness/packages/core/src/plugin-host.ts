import {
  PLUGIN_API_VERSION,
  type HarnessPlugin,
  type JsonValue,
  type PluginContext,
  type PluginDisposer,
  type PluginManifest,
} from "@zet-harness/plugin-api";

interface ActivePlugin {
  readonly plugin: HarnessPlugin;
  readonly disposers: PluginDisposer[];
}

async function disposeStack(disposers: readonly PluginDisposer[]): Promise<unknown[]> {
  const errors: unknown[] = [];

  for (let index = disposers.length - 1; index >= 0; index -= 1) {
    const disposer = disposers[index];
    if (!disposer) {
      continue;
    }

    try {
      await disposer();
    } catch (error) {
      errors.push(error);
    }
  }

  return errors;
}

function assertNonEmpty(value: string, field: string): void {
  if (value.trim().length === 0) {
    throw new Error(`Plugin manifest field "${field}" must be a non-empty string.`);
  }
}

function validateManifest(manifest: PluginManifest): void {
  assertNonEmpty(manifest.id, "id");
  assertNonEmpty(manifest.name, "name");
  assertNonEmpty(manifest.version, "version");

  if (manifest.apiVersion !== PLUGIN_API_VERSION) {
    throw new Error(
      `Plugin "${manifest.id}" uses API version ${String(manifest.apiVersion)}; ` +
        `this host supports version ${PLUGIN_API_VERSION}.`,
    );
  }

  for (const capability of manifest.capabilities ?? []) {
    assertNonEmpty(capability.id, "capabilities[].id");
  }
}

/**
 * Minimal in-process plugin lifecycle host.
 *
 * Activation is transactional: a plugin is published to the active set only
 * after `activate` succeeds; partial activation is rolled back immediately.
 * Registries/services are intentionally not part of this class yet. The host
 * only owns lifecycle semantics: validation, activation scopes, rollback,
 * unload, and deterministic reverse-order cleanup.
 */
export class PluginHost {
  private readonly active = new Map<string, ActivePlugin>();
  private readonly activating = new Set<string>();

  get size(): number {
    return this.active.size;
  }

  has(pluginId: string): boolean {
    return this.active.has(pluginId);
  }

  listManifests(): readonly PluginManifest[] {
    return [...this.active.values()].map(({ plugin }) => plugin.manifest);
  }

  async activate(plugin: HarnessPlugin, config?: JsonValue): Promise<void> {
    validateManifest(plugin.manifest);

    const pluginId = plugin.manifest.id;
    if (this.active.has(pluginId) || this.activating.has(pluginId)) {
      throw new Error(`Plugin "${pluginId}" is already active or activating.`);
    }

    this.activating.add(pluginId);

    const disposers: PluginDisposer[] = [];
    let activationOpen = true;

    const context: PluginContext = {
      ...(config === undefined ? {} : { config }),
      onDispose(disposer): void {
        if (!activationOpen) {
          throw new Error(
            `Plugin "${pluginId}" attempted to register cleanup after activation completed.`,
          );
        }

        if (typeof disposer !== "function") {
          throw new TypeError(`Plugin "${pluginId}" registered a non-function disposer.`);
        }

        disposers.push(disposer);
      },
    };

    try {
      await plugin.activate(context);
      activationOpen = false;
      this.active.set(pluginId, { plugin, disposers });
    } catch (activationError) {
      activationOpen = false;
      const cleanupErrors = await disposeStack(disposers);

      if (cleanupErrors.length === 0) {
        throw activationError;
      }

      throw new AggregateError(
        [activationError, ...cleanupErrors],
        `Plugin "${pluginId}" activation failed and rollback also reported errors.`,
      );
    } finally {
      this.activating.delete(pluginId);
    }
  }

  async unload(pluginId: string): Promise<boolean> {
    if (this.activating.has(pluginId)) {
      throw new Error(`Plugin "${pluginId}" cannot be unloaded while activation is in progress.`);
    }

    const activePlugin = this.active.get(pluginId);
    if (!activePlugin) {
      return false;
    }

    // Remove first so a failed disposer cannot leave the plugin falsely marked active.
    this.active.delete(pluginId);

    const cleanupErrors = await disposeStack(activePlugin.disposers);
    if (cleanupErrors.length > 0) {
      throw new AggregateError(cleanupErrors, `Plugin "${pluginId}" cleanup reported errors.`);
    }

    return true;
  }

  async dispose(): Promise<void> {
    if (this.activating.size > 0) {
      throw new Error("Plugin host cannot dispose while plugin activation is in progress.");
    }

    const pluginIds = [...this.active.keys()].reverse();
    const cleanupErrors: unknown[] = [];

    for (const pluginId of pluginIds) {
      try {
        await this.unload(pluginId);
      } catch (error) {
        cleanupErrors.push(error);
      }
    }

    if (cleanupErrors.length > 0) {
      throw new AggregateError(cleanupErrors, "Plugin host cleanup reported errors.");
    }
  }
}

import { expect, it, vi } from "vitest";
import { createRuntimePluginMaker } from "./runtime-plugin-maker.js";
import type {
  MakerOperationAuthority,
  PluginMakerControllerHost,
} from "./runtime-plugin-maker-controller.js";
import { createRuntimePluginMakerController } from "./runtime-plugin-maker-controller.js";
function setup() {
  const authority = {};
  const maker = createRuntimePluginMaker({ write: () => Promise.resolve() }, authority);
  let scope = 0;
  const host = {
    materialize: vi.fn<PluginMakerControllerHost["materialize"]>(() => Promise.resolve()),
    test: vi.fn(() =>
      Promise.resolve({ executed: true, passed: true, mode: "required-os-sandbox" as const }),
    ),
    enable: vi.fn(() => Promise.resolve({ restartRequired: true })),
  };
  const controller = createRuntimePluginMakerController({
    maker,
    userAuthority: authority,
    host,
    scopeGeneration: () => scope,
  });
  return {
    maker,
    host,
    controller,
    switchScope: () => {
      scope++;
    },
  };
}
it("requires exact human materialization review and actual sandbox test before enable", async () => {
  const f = setup();
  const a = (await f.controller.action("scaffold", { id: "example.review", name: "Review" })) as {
    hash: string;
  };
  const proof = { hash: a.hash, directory: "drafts/review", scopes: [], confirm: true };
  await expect(f.controller.action("enable", { ...proof, allowExecution: true })).rejects.toThrow();
  await f.controller.action("materialize", proof);
  await f.controller.action("review", proof);
  await expect(f.controller.action("test", proof)).rejects.toThrow();
  await f.controller.action("test", { ...proof, allowExecution: true });
  await f.controller.action("enable", { ...proof, allowExecution: true });
  expect(f.host.enable).toHaveBeenCalledOnce();
  expect(f.controller.snapshot().enabled).toBe(true);
});
it("refuses blocked/static execution proof, scope changes and edited artifact review reuse", async () => {
  const f = setup();
  const a = (await f.controller.action("scaffold", { id: "example.review", name: "Review" })) as {
    hash: string;
  };
  const proof = { hash: a.hash, directory: "drafts/review", scopes: [], confirm: true };
  await f.controller.action("materialize", proof);
  await f.controller.action("review", proof);
  f.host.test.mockResolvedValue({ executed: false, passed: false, mode: "required-os-sandbox" });
  await f.controller.action("test", { ...proof, allowExecution: true });
  await expect(f.controller.action("enable", { ...proof, allowExecution: true })).rejects.toThrow();
  f.switchScope();
  expect(f.controller.snapshot()).toMatchObject({
    artifact: null,
    scopeGeneration: 1,
    reviewed: false,
    enabled: false,
  });
  await expect(f.controller.action("materialize", proof)).rejects.toThrow();
  expect(f.host.enable).not.toHaveBeenCalled();
});

it("revokes pending side effect authority on edit and explicit scope invalidation", async () => {
  const f = setup();
  const a = (await f.controller.action("scaffold", { id: "example.race", name: "Race" })) as {
    hash: string;
  };
  let release!: () => void;
  let captured: MakerOperationAuthority | undefined;
  f.host.materialize.mockImplementation((_artifact, _directory, operation) => {
    captured = operation;
    return new Promise<void>((resolve) => {
      release = resolve;
    });
  });
  const pending = f.controller.action("materialize", {
    hash: a.hash,
    directory: "drafts/race",
    scopes: [],
    confirm: true,
  });
  expect(captured?.signal.aborted).toBe(false);
  await f.controller.action("edit", {
    hash: a.hash,
    path: "README.md",
    content: "New exact artifact revision.",
  });
  expect(captured?.signal.aborted).toBe(true);
  expect(() => captured?.check()).toThrow();
  release();
  await expect(pending).rejects.toThrow();
  f.controller.invalidateScope();
  expect(f.controller.snapshot().artifact).toBeNull();
});

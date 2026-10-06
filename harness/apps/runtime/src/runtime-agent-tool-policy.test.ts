import { expect, it, vi } from "vitest";
import type { ToolAdapter } from "@zet-harness/plugin-api";
import {
  agentToolAllowlist,
  agentToolCatalog,
  readRecordedAgentToolCatalog,
  registeredAgentToolOwner,
  restrictAgentTools,
} from "./runtime-agent-tool-policy.js";
const tool = (id: string, version = "1"): ToolAdapter => ({
  manifest: {
    id,
    version,
    title: id,
    inputSchema: true,
    outputSchema: true,
    behavior: {
      primitiveFamily: "effect",
      determinism: "nondeterministic",
      effect: "external-read",
      idempotency: "idempotent",
      recovery: "rerun",
      executionMode: "in-process",
      requiredCapabilities: [],
    },
  },
  invoke: () => Promise.resolve({ value: {} }),
});
it("defaults to authorized candidates and an empty canonical allowlist denies every alias", () => {
  const read = tool("plugin.read");
  const write = tool("plugin.write");
  expect(restrictAgentTools([read, write])).toEqual([read, write]);
  expect(restrictAgentTools([read, write], { allowlist: [] })).toEqual([]);
  expect(restrictAgentTools([read, write], { allowlist: ["plugin_read"] })).toEqual([]);
  expect(restrictAgentTools([read, write], { allowlist: ["plugin.read"] })).toEqual([read]);
});
it("fails closed for alias collisions and competing adapters with the same ID", () => {
  const one = tool("plugin.read");
  const alias = tool("plugin_read");
  expect(restrictAgentTools([one, alias], { allowlist: ["plugin.read"] })).toEqual([]);
  expect(restrictAgentTools([one, tool("plugin.read", "2")])).toEqual([]);
  expect(restrictAgentTools([one, one])).toEqual([one]);
});
it("intersects the recorded parent catalog with current version, owner and node restrictions", () => {
  const read = tool("plugin.read");
  const write = tool("plugin.write");
  const owner = () => "trusted.plugin";
  const recordedCatalog = agentToolCatalog([read], owner);
  expect(restrictAgentTools([read, write], { owner, recordedCatalog })).toEqual([read]);
  expect(
    restrictAgentTools([read], { owner: () => "replacement.plugin", recordedCatalog }),
  ).toEqual([]);
  expect(restrictAgentTools([tool("plugin.read", "2")], { owner, recordedCatalog })).toEqual([]);
  expect(restrictAgentTools([read], { owner, recordedCatalog, allowlist: [] })).toEqual([]);
  expect(restrictAgentTools([read], { owner: () => undefined })).toEqual([]);
  expect(
    restrictAgentTools([read], { recordedCatalog: readRecordedAgentToolCatalog(undefined) }),
  ).toEqual([]);
});
it("trusts registry resolution only for its exact registered adapter instance", () => {
  const registered = tool("plugin.read");
  const spoof = tool("plugin.read");
  const registry = {
    getAdapter: vi.fn(() => registered),
    getResolution: vi.fn(() => ({ plugin: { id: "actual.owner", version: "1" } })),
  };
  expect(registeredAgentToolOwner(registry, registered)).toBe(
    JSON.stringify(["actual.owner", "1"]),
  );
  expect(registeredAgentToolOwner(registry, spoof)).toBeUndefined();
  expect(registry.getResolution).toHaveBeenCalledTimes(1);
});
it("validates canonical graph configuration and ignores untrusted malformed records", () => {
  expect(agentToolAllowlist({})).toBeUndefined();
  expect(agentToolAllowlist({ toolAllowlist: [] })).toEqual([]);
  for (const value of [["plugin.read", "plugin.read"], ["*"], [null], ["plugin read"]])
    expect(() => agentToolAllowlist({ toolAllowlist: value })).toThrow("Invalid");
  expect(
    readRecordedAgentToolCatalog({
      toolCatalog: [
        { id: "x", version: "1", owner: "p" },
        { id: "bad", owner: "p" },
      ],
    }),
  ).toEqual([{ id: "x", version: "1", owner: "p" }]);
});

import { readFileSync, writeFileSync } from "node:fs";

const todoPath = "harness/TODO.md";
let todo = readFileSync(todoPath, "utf8");
const todoOld = "- [ ] 5.5 Add capability-based permission policy.";
if (!todo.includes(todoOld)) throw new Error("TODO 5.5 marker not found");
todo = todo.replace(todoOld, "- [x] 5.5 Add capability-based permission policy.");
writeFileSync(todoPath, todo);

const planPath = "harness/PLAN.md";
let plan = readFileSync(planPath, "utf8");
const oldTree = [
  "           ├─ 5.4 reconciliation/manual-review outcomes                        ✅",
  "           └─ 5.5 capability-based permission policy                           ▶ CURRENT",
].join("\n");
const newTree = [
  "           ├─ 5.4 reconciliation/manual-review outcomes                        ✅",
  "           ├─ 5.5 capability-based permission policy                           ✅",
  "           └─ 5.6 compile-time graph/node capability enforcement                ▶ CURRENT",
].join("\n");
if (!plan.includes(oldTree)) throw new Error("PLAN Phase 5 tree marker not found");
plan = plan.replace(oldTree, newTree);

const oldStatus = "🚧 In progress — **5.5 current**";
if (!plan.includes(oldStatus)) throw new Error("PLAN phase-map status marker not found");
plan = plan.replace(oldStatus, "🚧 In progress — **5.6 current**");

const paragraph = "Phase 5.5 adds one host-owned capability permission policy in `@zet-harness/core` without expanding Graph JSON/schema validation or prematurely wiring invocation enforcement. Capability IDs are opaque exact case-sensitive strings in v1: there are no wildcard, prefix, hierarchy, or implication semantics. Authority is default-deny, explicit denial overrides an overlapping grant, and construction copies/deduplicates caller inputs into immutable snapshots so later mutation cannot change an existing decision. Single-capability evaluation returns explicit allow/deny plus the safe denial cause (`explicitly-denied` or `not-granted`), while required capability sets use deterministic all-of evaluation and preserve those causes separately. Graph, node, plugin, model, and tool declarations remain requests rather than sources of authority. Phase 5.6 consumes this shared policy for compile-time graph/node enforcement and Phase 5.7 reuses the same semantics at invocation time.";
const anchor = "\n\nPhase 4.10 adds migration v4";
if (!plan.includes(paragraph)) {
  if (!plan.includes(anchor)) throw new Error("PLAN 5.5 insertion anchor not found");
  plan = plan.replace(anchor, `\n\n${paragraph}${anchor}`);
}

const oldNext = "> **Phase 5 / Item 5.1 — Define and enforce cross-field effect/idempotency/recovery invariants over the Phase 1 node enums.**";
if (plan.includes(oldNext)) {
  plan = plan.replace(
    oldNext,
    "> **Phase 5 / Item 5.6 — Enforce graph/node capabilities at compile time using the host-owned capability permission policy.**",
  );
}
writeFileSync(planPath, plan);

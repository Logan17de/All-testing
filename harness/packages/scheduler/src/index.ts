// Phase 3 scheduler primitives: 3.1 op states; 3.2 FIFO readiness + pair-specific dependency counters; 3.3 bounded global/per-run concurrency; 3.4 concurrent plain-DAG execution; 3.5 selected router-branch activation; 3.6 explicit unresolved/active/skipped/completed control-edge runtime states; 3.7 activation-aware all-active joins with definitive skipped-path propagation; 3.8 explicit any/quorum joins with lane-based thresholds and impossible-threshold skipping; 3.9 cooperative run cancellation with AbortController/AbortSignal and abortable concurrency waiters; 3.10 per-node execution timeouts with op-local abort signals and timeout failure isolation; 3.11 bounded scheduler-owned retry attempts with retry-wait readiness and deterministic backoff/jitter hooks; 3.12 shared outer + adapter/internal retry accounting under one maxAttempts budget; 3.13 tiny synchronous typed runtime event emitter with deterministic subscription ordering and snapshot delivery semantics; 3.14 explicit transient-vs-durable runtime event classification with disjoint typed channels and no persistence implementation. Phase 4.15 adds an optional completion barrier so durable runtimes can commit successful work before scheduler-visible completion/dependency release; barrier failure is terminal and does not rerun successful executor work.
export * from "./op-status.js";
export * from "./run-readiness.js";
export * from "./concurrency.js";
export * from "./plain-dag-run.js";
export * from "./control-edge-state.js";
export * from "./router-activation.js";
export * from "./join-activation.js";
export * from "./runtime-event-emitter.js";
export * from "./runtime-event-channels.js";

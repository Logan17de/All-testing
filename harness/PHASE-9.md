# Phase 9 — Replay, fork, memory, triggers and external clients

Phase 9 builds on the durable journal from Phase 4 and the agent work from Phase 8. `PLAN.md` keeps
three ideas apart, and this phase follows that split:

1. **Resume** continues unfinished work from committed outputs. The runtime has done this since
   Phase 4.
2. **Recorded replay** reads a run back from its records and runs nothing.
3. **Fork** starts a new run from a checkpoint and executes the downstream work again.

## Slice 1 — read-only recorded replay (9.1)

Any run, finished or not, can now be replayed from its records alone.

- **What it returns.** `replayRecordedRun(connection, runId)` walks the run's durable journal in
  order and returns one step per recorded thing that happened. Each attempt carries its node,
  iteration, attempt number, the inputs it received, and its recorded outputs and usage or its
  error. Router branches, loop entries and decisions (including why a loop ended), approval
  requests and resolutions (with the approved response), recovery outcomes and the run's end each
  become a step.
- **Inputs are re-derived, not guessed.** The journal does not store inputs, so replay resolves them
  the way the dispatcher does: literals, compiled graph input defaults, and the outputs recorded
  upstream at that point in the journal, using the same iteration's value inside a loop body and the
  latest value everywhere else. Secret bindings appear only as their reference, never as material.
- **Nothing runs and nothing is written.** No node executor, model, tool or person is called, and
  the journal and attempt tables are untouched, so replaying is safe on any run at any time and
  gives the same result every time.
- **It checks the records agree.** Every finished attempt must be journaled, every journaled attempt
  must be stored with the same status, every input must have had a recorded value, and the journal
  must end the run with the status the run has. Disagreements come back as `issues` with a
  `consistent: false` flag instead of an exception, so a damaged run can still be inspected. Stored
  values pass through the runtime's redaction before they leave the daemon.
- **HTTP.** `GET /api/runs/:id/replay` returns the replay; an unknown run is `RUN_NOT_FOUND` (404).

Covered by `runtime-replay.test.ts` (a data chain with derived inputs, proof that replay runs no node
and writes no row, identical repeated replays, three loop iterations with each decision and the
`max-iterations` exit reason, a failed attempt and failed run, and an unknown run) and
`runtime-replay-http.test.ts`, which replays a run of the built-in condition node through the API.

Not yet: showing a replay step by step in the run inspector.

## Slice 2 — fork a run from a point in its history (9.2)

A new run can now start from any point in another run's history. The run it came from is never
written.

- **Where to fork.** `forkRun(database, runId, { throughEventId })` cuts the parent's journal after
  one of its events, such as the event of a step in its replay, or after its latest event when none
  is given. A commit journals its own event before the frontier changes it caused, so the cut moves
  to the end of the commit it fell in. A fork never starts with an upstream node finished and its
  downstream not yet released.
- **The frontier at that point.** Recovery can now rebuild a run's frontier as it stood after any
  event: the latest checkpoint at or before the cut, then the frontier events up to it, without
  overlaying today's attempt rows.
- **What the fork keeps.** Work that had finished by the cut keeps its recorded attempts, results,
  logical effect ids and journal events, including branch choices and loop decisions. A replay of
  the fork shows that history, and downstream nodes read the same upstream values. Reused attempts
  are part of the fork's record, so they count toward its node-execution budget. A
  `harness.run.forked` event marks where the fork's own history begins.
- **What runs again.** Everything else starts again with a fresh attempt budget: a node that was
  running or waiting to retry, a node that failed (so forking a failed run retries it), and a human
  approval that was waiting, which is asked again with a new request while the parent's request
  stays pending. A loop that was running carries on from its next iteration with a fresh wall-time
  window. A loop that failed or was cancelled cannot be forked yet (`FORK_UNSUPPORTED`).
- **Lineage.** The fork is an ordinary `pending` run on the same compiled plan, admitted by the
  dispatcher like any other. Its `parent_run_id` names the parent, and its fork metadata records the
  cut event, the parent checkpoint the cut was rebuilt from, and the fork's own starting checkpoint.
- **Refusals.** An unknown run is `RUN_NOT_FOUND` (404). An event of a different run, a point that
  is not a positive whole number, or a point inside the history a fork copied from its parent is
  `FORK_POINT_INVALID` (422); fork the original run to go further back.
- **HTTP.** `POST /api/runs/:id/fork` with `{}` or `{ "throughEventId": 12 }` returns `201` with the
  fork and starts it.

Covered by `runtime-fork.test.ts` (forking a finished run after its first node, where only the
second node runs and every row of the parent is unchanged; retrying a failed run; carrying a running
loop over to finish its iterations; asking a waiting approval again in the fork; and the refusals)
and `runtime-fork-http.test.ts`, which forks a run through the API and replays the fork.

## Slice 3 — lineage in the run view and the inspector (9.3)

Forks are now visible, and one can be made from the browser.

- **In the run view.** A run reports `forkedFrom` (the parent run, the event it was cut after, the
  parent checkpoint it was rebuilt from and its own starting checkpoint) and `forks`, the runs made
  from it. A run's own `parent_run_id` is authoritative; the fork point comes from its metadata, and
  a run whose metadata cannot be read still reports its parent. The run list reports each run's
  parent too.
- **In the inspector.** A forked run says where it came from and links to that run, the panel lists
  the forks made from a run, and the run list marks a fork. A **Fork run** button starts a new run
  from where this one has got to and opens it; the run it came from is not changed.
- **HTTP.** The editor proxies the fork through `POST /api/editor/runs/:id/fork`, with the same
  loopback, same-origin and JSON checks as every other editor mutation.

Covered by a run-view test for a fork's parent, a run's forks and the parent in the run list, and by
driving the browser: forking a finished run from the inspector and following the new run.

## Slice 4 — refuse to resume against changed work (9.4)

A run is admitted against one compiled plan and the exact node versions the compiler resolved. Both
can change under it between one wake-up and the next: the stored plan could be edited, and the
plugins behind its nodes can be upgraded, disabled or removed. Either way, resuming would run work
the run never started.

- **The plan's own content.** The Execution IR is content-hashed at compile time, so the stored plan
  is re-hashed and compared before a run is admitted. No recompilation is involved, and the
  authoring document is not re-checked because execution never reads it.
- **The code behind it.** A plan pins each node to a `type@version` and the plugin id and version it
  resolved to. The daemon reports how it would resolve those nodes now, so a node that no longer
  exists (`PLAN_NODE_UNAVAILABLE`) or now comes from a different plugin version
  (`PLAN_PLUGIN_CHANGED`) is caught without running anything.
- **What refusal means.** The run is left exactly as it is: no attempt starts, no status changes,
  nothing is silently continued. The dispatcher reports `RUNTIME_PLAN_IDENTITY_CHANGED`, and the
  reason is journaled once as `harness.run.identity-mismatch` with the issues it found, so a replay
  shows it and the inspector explains it instead of leaving a run mysteriously stuck.
- **Cost.** A compiled plan is immutable, so each plan is verified once per process.
- **Already covered elsewhere.** Running an edited graph under a revision id that already names
  different content is refused at creation (`GRAPH_REVISION_CONFLICT`), and a fork always re-runs
  the same compiled plan its parent used.

Covered by `runtime-plan-identity.test.ts`: an edited plan row, a node whose plugin version moved,
a node that no longer resolves, the entry being journaled once however often the run is woken, and
an unchanged run still completing.

## Slice 5 — what a project remembers (9.5)

A project can now keep small pieces of written text that outlive any one conversation or run.

- **A memory** is a title and a body, of one kind: a `fact`, a `preference`, a `decision` or a plain
  `note`. It records who wrote it, a person or an agent, and an agent's memory names the run it came
  from. It is deliberately not a transcript: conversations keep those, and a run keeps its journal.
- **Pinning.** A pinned memory is always offered first. Listing is ordered for recall — pinned
  first, then most recently changed — so a reader with a budget can stop at any point and still hold
  what matters most. That ordering is the one 9.6 will retrieve with.
- **Forgetting.** A memory can be removed outright rather than archived. Everything else durable in
  the harness is kept, but keeping a "forgotten" copy would defeat the point of being asked to
  forget something.
- **Storage.** Migration 15 adds `project_memories`, a STRICT table bound to its project and,
  optionally, the run that wrote it, with the usual identity trigger: a memory keeps its id,
  project, source and creation time.
- **HTTP.** `GET`/`POST /api/projects/:id/memories` (with `pinned=true`, `kind` and `limit`
  filters), and `GET`/`PATCH`/`DELETE /api/memories/:id`, refusing unknown fields, unknown kinds,
  empty or oversized text, and writes to an archived project.

Covered by `durable-memory-records.test.ts` and `runtime-memory-http.test.ts`.

Not yet: an agent reading or writing memories, which is 9.6, and a memory panel in the web app.

## Slice 6 — telling an agent what the project remembers (9.6)

An agent step now sees the project's memories, inside the same context budget as everything else.

- **What it sees.** One `memory` section, listing memories in recall order — pinned first, then most
  recently changed — as `- [kind, pinned] title: body`, introduced as background rather than
  instructions. Long bodies are trimmed to 400 characters in the summary; the full text stays in the
  store. A project that remembers nothing adds no section at all.
- **Inside the budget.** The section is optional, so a context under pressure drops the memories
  before the conversation or the required system and goal sections, exactly as the context builder
  already does for optional sections.
- **Accounted for.** The step's usage records `memory: { offered, included }` beside the existing
  per-section token and byte report, so it is visible whether memories were offered and whether they
  fitted.
- **Per step.** `maxMemories` on an agent model node bounds how many are offered (20 by default,
  100 at most); `0` offers none, for a step that should not see project memory.

Covered by `runtime-agent-memory.test.ts`: the order and formatting an agent sees, silence when
there is nothing to remember, memories dropped first under a tight byte cap while the conversation
and goals survive, and both `maxMemories` bounds.

Not yet: an agent writing memories of its own, and a memory panel in the web app.

## Slice 7 — summarizing a conversation only when it no longer fits (9.7)

Nothing summarizes on a schedule. A step summarizes only when its conversation no longer fits the
context it is allowed, and then only the messages that would otherwise have been dropped.

- **When.** The step builds its context; if the conversation section had to drop its oldest
  messages, exactly those are folded into one summary and the context is rebuilt. A conversation
  that fits is never summarized, and no model call is made for it.
- **What is stored.** Migration 16 adds `conversation_summaries`: the text, how many messages it
  covers, the last message it covers, the model that wrote it, the run whose step wrote it, and the
  tokens it cost. Summaries are append-only, and writing the same cut twice keeps the first, so a
  retried step reuses the summary it already paid for.
- **How it is used.** A later step takes the summary covering the most of its branch, sends it as a
  short developer message in place of those messages, and sends the rest verbatim. A summary counts
  only on the branch it was made from, so an edit into a different branch never inherits a summary
  of messages it does not contain.
- **What it costs.** One extra model call, capped by `summaryMaxOutputTokens` (400 by default). Its
  tokens count toward the run's token budget alongside the messages, so summarizing cannot quietly
  spend past a limit. It is not a separate agent step.
- **Accounted for.** The step's usage records `summary: { used, wrote, throughMessageId, messages }`
  beside the context section report.

Covered by `runtime-agent-summary.test.ts`: a conversation that fits is left alone, an overlong one
is folded into a stored summary the step then uses, the next step reuses that summary instead of
writing another, and a summary's tokens push a run over its token budget.

## Slice 8 — search, and why there is no full-text index (9.8)

The plan made full-text search conditional: add it *only if* pinned and recent retrieval proves
insufficient. It has not, so this slice adds the smallest thing that was actually missing and
records the decision rather than the machinery.

- **What was added.** Listing a project's memories takes `q` (`search` in the record API): plain
  containment of the text in a memory's title or body, ignoring case, with `%` and `_` escaped so
  they are characters to look for rather than a query language. Results keep the recall order,
  pinned first and then most recently changed.
- **Why that is enough today.** A memory is at most 8 KB and a project's list is capped at 500, so
  a scan is a few hundred kilobytes at worst; an agent is offered a bounded number of memories in
  recall order, not a ranked search; and conversations are already compressed by 9.7 instead of
  being searched.
- **What FTS would cost now.** A shadow `fts5` table and triggers to keep it in step with every
  write, a tokenizer choice that decides what "matching" means, ranking that has to be explained in
  the UI, and a migration that cannot be undone. That is a real contract to keep for a gain nobody
  has asked for yet.
- **When to add it.** When a project's memories outgrow a scan (say, thousands), when messages
  themselves need searching rather than summarizing, or when containment demonstrably misses what
  people look for — ranking by relevance, stemming, or phrase queries. Then `fts5` goes in as its
  own migration behind the same `listMemories` and `q` interfaces, which is why search lives there
  rather than in the callers.

Covered by `durable-memory-records.test.ts` (containment across title and body, case-insensitive,
wildcards escaped, recall order kept, blank search ignored) and `runtime-memory-http.test.ts`.

## Next

9.9 and 9.10: triggers — manual, cron, webhook and API, all through one durable run-creation path,
with dedupe receipts and durable `not_before` scheduling instead of long-lived timers.

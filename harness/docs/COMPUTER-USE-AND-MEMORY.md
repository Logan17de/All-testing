# Memory and computer use: Hermes/OpenClaw-inspired implementation

## References and design choices

- [Hermes Agent: memory](https://hermes-agent.nousresearch.com/docs/user-guide/features/memory/)
  distinguishes curated, bounded notes from searching historical sessions.
- [Hermes Agent: computer use](https://github.com/NousResearch/hermes-agent/blob/main/website/docs/user-guide/features/computer-use.md)
  describes OS-specific computer drivers, accessibility surfaces, and screenshot delivery.
- [OpenClaw: computer use](https://docs.openclaw.ai/nodes/computer-use)
  binds coordinate actions to a reference frame, keeps host selection explicit, and
  discloses provider capability and refusal evidence.
- [OpenClaw: memory search](https://docs.openclaw.ai/concepts/memory-search)
  uses hybrid retrieval, scoped notes, diversity and recency considerations.

These are architecture references, **not** claims of feature parity. Zet Harness
does not import Hermes, OpenClaw, their credentials, or their profiles.

## Implemented memory capabilities

- The existing project memory store persists facts/decisions/notes in SQLite,
  marks agent-authored records with their run, and lets people forget notes.
- The agent already receives a bounded pinned-first summary and can list,
  remember and update the current project's records. Model-visible memories
  are **background data**, not an instruction hierarchy.
- `harness.memory.session-search` now provides on-demand exact-text retrieval
  over persisted **user/assistant text** from active and archived conversations
  **within the same project**. Default 6, maximum 10 results; 120-character
  bounded search and 500-character excerpts. It returns session/message ids and
  titles to establish provenance, not private reasoning, tool results, images,
  provider blobs, or other projects' transcripts. It is unavailable in the
  restricted assistant context where project memory is intentionally disabled.
- No session history is silently promoted into curated long-term memory.
  Embeddings, global user-profile memory, auto-extraction and FTS5 relevance
  ranking are not yet implemented. Search is lexical substring matching,
  not semantic similarity. To search, ask a configured model to use the
  **Find earlier conversations** tool.

## Implemented computer-use controls

- Windows has an **opt-in** local PowerShell desktop driver, not a bundled
  Windows accessibility service. It is off by default. The machine's OS
  permissions, interactive session, monitor layout, and window visibility matter.
- The selected monitor/window and explicit task are armed for at most two
  minutes; there are bounded actions, audits, expiry and stop/revocation.
  Every physical input requires an individual human decision.
- Screenshots are **local artifacts**. Sending pixels to a model requires a
  separate explicit run/session/model/account-bound transmission approval.
  Desktop preview is not blanket screenshot consent.
- `observed-click` binds pixel coordinates to the latest locally captured
  `artifactId`. It refuses a missing/old screenshot, a click outside the
  captured physical bounds, a frame after an intervening input, monitor layout
  changes, changed window identity/bounds, and an unfocused selected window.
  After human approval, the target is rechecked before dispatch. No fallback
  to an unscoped click is permitted.
- Model desktop tools **refuse raw `click`** actions and require
  `observed-click`. The manual local UI retains an explicitly approved
  `click (manual)` for a human who knows screen coordinates and adds a
  `click in latest screenshot` action.
- No claim is made of atomic protection against a window changing after the
  final identity check but before Windows dispatches input. Accessibility
  element references/background input and paired remote-node control remain
  future work; legacy pointer motion and key/text actions are not equivalent.
- The local model cannot self-arm, change the selected destination or grant
  permission. OS-level isolation is **not** established by UI confirmation.

## Acceptance before release

1. Green Linux and Windows typecheck, lint, format and focused tests.
2. Browser worker and native Windows Chromium page launch.
3. Hands-on Windows interactive desktop inventory, capture, observed-click
   refusal/success, consent rejection and stop.
4. Live provider tool roundtrip, with **no sensitive information** on the test
   desktop, and verified screenshot permission handling.
5. Verify memory survives restart, remains project-confined and does not leak
   private parts into search.

Local scripted tests alone cannot prove real computer-use readiness.

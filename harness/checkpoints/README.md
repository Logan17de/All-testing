# Pending Windows project dispatch

`windows-project-dispatch.pending.patch` is a reviewed proposal, not active runtime code.
It preserves four fixed commands, frozen host configuration and private paths,
exact per-call approval, required native containment, and cancellation after awaits.

The isolated preview passed 30 focused tests, runtime typecheck, lint and formatting.
Those tests use mocked native dispatch; they do not establish Windows kernel acceptance.

Apply only after the canonical native project-script positives and exact hardlink,
private-parent-junction, ambient-readable file and future-sidecar negatives pass.
Then require the prepared actual-daemon Windows approval fixture and full exact-head CI
before reporting project commands as available. Never enable a host execution fallback.

The daemon fixture uses scripted inference and actual native execution. It does not
exercise paid providers or real desktop input. Existing approval-generation and native
JobObject descendant/cancellation tests remain required; it does not claim to prove
interruption of an already-running project script.

Accepted primary testing build: `fbd3b11429ce21e10a0c4450215c0873dd132dad`.
Application source under native proof: `5e8020442f917b10eb3ef4e75c094fabffafdc1f`.

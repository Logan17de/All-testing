# Windows source-proof checkpoint

Ordinary Windows project tools are gated before consent and execution.
This checkpoint preserves work in progress; it is not a Windows availability release.

The ordinary functional run at `cd3d6ff67e8f7677d6f8a1dc098afd0d037740f9`
passed both platforms, including native project scripts, real daemon approvals,
startup, CLI, build and unchanged performance guards. Independent source review
then identified an original-tree access gap for permissive AppContainer ACLs.
Those ordinary tests did not cover that boundary.

The current bridge includes held original-object identities, bounded complete-tree
scanning, separate actual-token read/mutation denial checks and a draft prospective
file/directory inheritance closure. Native negatives and ordinary positives must
pass for the complete guard before normal dispatch can be enabled. No host fallback
or silent source ACL changes are permitted. External host security changes remain
a separate boundary; no Linux-like Windows namespace invisibility is claimed.

Two test-only durability fixtures have explicit bounded setup budgets after
observed Windows I/O timeouts. Assertions, SQLite settings, production deadlines
and numeric performance guards are unchanged.

Accepted primary testing build: `fbd3b11429ce21e10a0c4450215c0873dd132dad`.

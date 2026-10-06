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
The proof covers existing canonical non-reparse objects and newly created ordinary
host files/directories with inherited security. Concurrent host ACL/label changes,
reparse points/junctions/symlinks, hardlinks and moves importing another object's
security are outside this proof.

Native proof run `37407076390` at `10096eca1734eb1d0fb8ae839beb2fc78c697f78`
passed Ubuntu and failed four focused Windows checks: ordinary execution and the
original-source negative stopped at token-policy validation, the future-label
setup did not match its strict readback, and the delayed payload did not start.
Seven focused checks passed. This is a failed experiment, not source isolation
acceptance. A diagnostic follow-up preserves every requirement and the tool gate.

Native diagnostic run `37408190154` at `4047721f4a7da8c61e296f7f4f6dafe10738760a`
also passed Ubuntu and failed four Windows checks. It confirmed child mandatory
policy `1` and label readback with only the `S:AI` inheritance-control marker added.
The reviewed follow-up attempts to add the process-integrity minimum restriction
only to the owned suspended child token and requires exact policy `3` readback.
Unsupported setters still refuse before execution; host privileges and ACLs are
unchanged. Fixture readback permits only the identical requested ACE with the
observed inheritance marker. Native acceptance remains required.

Native run `37409100736` at `b35109f6b21cc4eafbd96ba2d230ee424bbddb6d`
passed Ubuntu and failed Windows focused acceptance (six passed, five failed).
Windows rejected the suspended-token policy change with
`project-source-token-policy-strengthen:1314` (required privilege not held).
Another private-path negative stopped at `file-canonical:0`. No host privileges
were enabled and no weaker policy or host execution fallback was used.
Windows project commands remain unavailable on this tested configuration.
Use the accepted Linux execution route, or separately review a supported Windows
sandbox setup; persistent accounts or credentials require explicit user consent.

The private-state follow-up also rejects unsupported DACL rules outside the source
tree, checks each existing-file/parent mutation right separately, and validates
inherited future sidecar integrity. These guards and their synthetic native
fixtures have source/local verification only until the Windows prerequisite is
resolved. They do not remove the availability gate.

Checkpoint `934ba0072b27ff0f36f8445f35dad58c943132cd`, run `37410703826`,
passed Ubuntu and failed Windows focused acceptance (six passed, seven failed):
five token-policy prerequisite refusals `1314` and two `Get-Acl` module-loading
errors during private fixture setup. The test-only module-path adjustment did
not fix those setup errors; they are separate from the native privilege blocker.
No further unchanged blocked kernel rerun is requested.

The [dedicated-user preparation design](../WINDOWS-SANDBOX-REVIEW.md) and
`windows:sandbox-plan` CLI produce disabled review metadata only. They neither
repair the AppContainer refusal nor provision or enable a new backend. The native
candidate needs administrator and persistent-credential approval, reviewed
implementation and new kernel proof; the accepted Linux route remains available.

The [broker preparation follow-up](../WINDOWS-BROKER-PREPARATION.md) adds strict
fixed-command request bindings, bounded expiry, a synthetic ordered launch
sequence and a readiness report that remains disabled even for imported
all-reviewed metadata. No OS launcher, provisioner, durable replay custody or
host attestation is implemented. Cross-user broker privileges, credential
identity/profile/storage, effective network/IPC enforcement and exact source
scope remain unresolved. The assessed foreign sandbox identity is not reused.

Two test-only durability fixtures have explicit bounded setup budgets after
observed Windows I/O timeouts. Assertions, SQLite settings, production deadlines
and numeric performance guards are unchanged.

Accepted primary testing build: `fbd3b11429ce21e10a0c4450215c0873dd132dad`.

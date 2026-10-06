# Windows broker preparation

Status: review preparation only, 2026-10-06. There is no native broker implementation, provisioner, credential store, signing implementation, installed service or scheduled task in this proposal. Ordinary code and synthetic protocol tests can proceed without permission to modify a PC. Account creation, credential generation, policy changes and privileged execution require separate explicit action-time human approval; neither this document nor a planner supplies it.

The accepted `fbd` primary baseline and current closed Windows project-execution gate remain unchanged. See [the sandbox review design](WINDOWS-SANDBOX-REVIEW.md) for its bounded acceptance evidence, token constraints and rollback requirements. Preparing a native candidate does not make that route available or repair the existing AppContainer error-1314 boundary.

## Current readiness findings

Only general findings belong here; assessment logs, machine/account names, ownership identifiers and actual private paths are excluded.

- Broad `Authenticated Users` modify access on an assessed source tree is incompatible with claiming source isolation from a new account alone. Original-source ACLs must remain unchanged. Restricting-token feasibility and actual source/private read and mutation denial are unresolved; refuse execution if ambient access cannot be excluded.
- A token assessed with only `SeChangeNotifyPrivilege` belongs to another application. It is not a harness token, broker identity or reusable account. Its observation proves neither cross-user launch nor the future worker's effective restrictions.
- Effective external, IPv4/IPv6 loopback and privileged local IPC denial is unknown or unavailable. An environment flag, proposed firewall rule or successful rule creation cannot establish enforcement. Native apply remains blocked until the required boundary can be independently proved.
- An assessed Node 24.19 runtime is below the harness requirement of Node >=24.20 and <25. Selecting a compatible runtime is necessary but does not prove Windows sandbox readiness.
- The approved source-file allowlist, excluded private-state paths and bounded command families have not been selected. No project command is authorized by preparation.

## Minimal launch candidate to review

The candidate is an on-demand human-authorized broker, not a continuously privileged general agent. After separately approved provisioning, it would authenticate a new owned disabled-at-rest nonadministrator worker using `LogonUser` with the selected noninteractive batch logon type, derive and verify a restricting primary token, and launch through `CreateProcessAsUser` into a private noninteractive window station/desktop. The process starts suspended, enters a non-breakaway kill-on-close JobObject with validated handle/environment restrictions, and resumes only after all checks pass. The exact APIs, rights, identity transitions and disabled-account enable/logon/re-disable lifecycle remain unimplemented and unproved.

| API | Supported API fact | Candidate decision |
| --- | --- | --- |
| `LogonUser` with batch logon | The selected account needs the corresponding logon right and an appropriate token type | Prove exact new worker rights and effective GPO; do not grant interactive logon or reuse another application's identity |
| `CreateProcessAsUser` | Typically requires increase-quota privilege and may require assign-primary-token privilege | Review a narrowly trusted broker's actual token and launch path; the same-user restricted-token exception does not prove cross-user launch |
| `CreateProcessWithLogonW` | Requires local interactive logon; accepts credentials rather than an already restricted primary token | Not the proposed restricted batch-launch substitute; `LOGON_NETCREDENTIALS_ONLY` retains the caller's local token and cannot establish isolation |
| `CreateProcessWithTokenW` | Requires impersonation privilege | Not a privilege-free fallback; any use requires a separate broker/privilege review |

These distinctions follow Microsoft's [LogonUser](https://learn.microsoft.com/en-us/windows/win32/api/winbase/nf-winbase-logonuserw), [CreateProcessAsUser](https://learn.microsoft.com/en-us/windows/win32/api/processthreadsapi/nf-processthreadsapi-createprocessasuserw), [CreateProcessWithLogonW](https://learn.microsoft.com/en-us/windows/win32/api/winbase/nf-winbase-createprocesswithlogonw) and [CreateProcessWithTokenW](https://learn.microsoft.com/en-us/windows/win32/api/winbase/nf-winbase-createprocesswithtokenw) documentation. Listing supported Windows APIs is not evidence that this broker exists or can safely launch on the assessed host.

Administrator elevation alone is not proof of the required quota/assign-primary-token privileges. Inspect and prove the exact broker token and chosen API before any launch implementation can be accepted; do not grant missing privileges to make a test pass.

Token construction must enforce read and write restricting-SID checks, prohibit `WRITE_RESTRICTED` and `SANDBOX_INERT`, verify exact nonempty restricting SIDs/groups/privileges, and never add broad ambient groups to enable tool loading. A private desktop is mandatory. The candidate must independently prove existing and future file/directory reads and every mutation with its actual token, including ownership, default/null/conditional DACLs and inheritance closure. Existing Low-AppContainer versus Medium/no-write-up evidence cannot be reused for a Medium worker. See [Microsoft's restricted-token requirements](https://learn.microsoft.com/en-us/windows/win32/api/securitybaseapi/nf-securitybaseapi-createrestrictedtoken).

## Protected storage and broker identity remain undecided

An unelevated broker cannot assume access to an object protected exclusively for SYSTEM and administrators. User-context DPAPI does not overcome that object's ACL. Choose and review either an explicitly elevated per-action broker with the exact protected-store access it needs, or a narrowly granted ACL on a newly owned broker object for the selected trusted identity. Neither choice may grant the worker access, alter original/private host objects, or broaden unrelated ACLs.

Current-user DPAPI protection must use the chosen trusted broker context, with separate explicit consent for persistent credential creation/storage and recovery. Machine-scope DPAPI is not a substitute: [Microsoft documents that other users on the machine can decrypt machine-scope data](https://learn.microsoft.com/en-us/windows/win32/api/dpapi/nf-dpapi-cryptprotectdata). No service, scheduled task, automatic elevation, signing key, credential or generic privileged IPC endpoint is created as a shortcut. Secrets must not enter source copies, model prompts, command environments, receipts or logs.

The exact decrypting user and profile must be available. `LogonUser` and impersonation do not load the user profile; explicit [LoadUserProfile](https://learn.microsoft.com/en-us/windows/win32/api/userenv/nf-userenv-loaduserprofilew) requires backup/restore privileges and an administrator or LocalSystem caller. Do not implicitly grant these rights or change broker identity to repair DPAPI access. Use a proven already-loaded trusted context or resolve storage/lifecycle separately. A later SYSTEM broker is not assumed able to decrypt another user's current-user blob.

## Required decisions before any PC apply

A reviewable plan must name the exact approved source entries, private-state exclusions, command family and immutable runner identity; fresh owned account/SID recording procedure; scratch ancestry; trusted broker identity; credential-store protection; minimum logon-right deltas; identity-scoped network resources; token policy; private desktop; job limits; and expiry/cancellation behavior. The human must review persistent effects and separately authorize credential creation and each privileged action. Protected nonsecret receipts and plan integrity cannot replace that consent.

Before approving launch, resolve external and IPv4/IPv6 loopback denial, DNS/UDP/SMB and privileged IPC containment with actual kernel probes. If the mechanism cannot establish those boundaries, do not apply native provisioning as an experiment on the user's PC. Select a separately approved isolated Linux backend or keep execution unavailable.

Rule owner/name or executable path is not effective worker-SID traffic matching. Native proof must cover IPv4-mapped dual-stack traffic, applicable protocols and service-mediated networking under other identities. WFP loopback support does not establish that a proposed ordinary firewall rule covers loopback; SID-bound socket filtering does not establish IPC containment.

Teardown first closes admission, invalidates authorization, disables the exact owned worker, kills and verifies owned descendants, and retains network protection until containment is confirmed. Reverse only receipt-bound owned changes whose current identities and expected state still match. Concurrent changes stop rollback for review; never reset global firewall/policy, restore broad ACL snapshots, remove accounts by name alone, reuse another application's SID, or delete unverified trees. Credential loss, interrupted provisioning and account deletion have persistent recovery implications and must be disclosed before approval.

## Evidence boundary

The existing [plan implementation](apps/runtime/src/runtime-windows-sandbox-plan.ts), [plan tests](apps/runtime/src/runtime-windows-sandbox-plan.test.ts) and [review-only CLI tests](scripts/windows-sandbox-plan.test.ts) exercise candidate planning and refusal behavior. The new [broker protocol](apps/runtime/src/runtime-windows-broker-protocol.ts) and [readiness assessment](apps/runtime/src/runtime-windows-broker-readiness.ts) are preparation modules. Readiness evaluates read-only human-supplied candidate metadata, not host attestation; it remains disabled with no execution even if every supplied readiness item is green. Its blockers cover API privileges, credential identity/access, unreadable effective policy, network/IPC proof, source/future-object proof, unselected scope, the Node version floor, foreign sandbox identity and unavailable native implementation. Synthetic fixtures establish schema, binding and fail-closed decisions only; they are not Windows kernel proof, protected-store proof, provisioning acceptance or consent to execute.

The next concrete step is to settle the launch/storage/network decisions in source review and test the resulting implementation on a separately approved disposable Windows environment. No native OS backend or PC apply is authorized by that step alone. The current gate stays closed until implementation review, fresh exact-commit platform acceptance and real action-time user authorization all succeed.

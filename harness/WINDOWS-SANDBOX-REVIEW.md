# Windows project execution: review design

Status: proposal only, 2026-10-06. This document does not implement or accept a new native sandbox, authorize provisioning, or release the current Windows project-command security hold. A planner may describe changes; it cannot authorize or apply them. No users, credentials, ACLs, policy, firewall rules or services were created for this review.

The accepted `fbd` primary baseline remains limited to the filesystem, fixed diagnostics, network/outsider-denial and descendant-kill probes in [CI run 37397400829, job 112056534197](https://github.com/Logan17de/All-testing/actions/runs/37397400829/job/112056534197). That evidence does not accept arbitrary Windows project scripts or either new design below. Experimental Windows project execution stays disabled until separate source review and fresh exact-commit kernel acceptance succeed.

## Decision to review

The goal is useful offline project tests with a stronger separation from the interactive user's identity, credentials, source tree and private runtime state. The execution backend remains independent of the provider. No provider client identity, credential extraction or agent engine is involved.

| Option | Proposed boundary | Important limitation | Review position |
| --- | --- | --- | --- |
| Dedicated Windows offline user | Owned nonadministrator identity, protected disposable project copy, validated broker, scoped network enforcement, suspended launch into a non-breakaway JobObject | A user identity is not a filesystem namespace. Ambient readable files, local services, device access, effective enterprise policy and IPC must be evaluated; a JobObject alone is not a security boundary | Native alternative to prototype only after explicit provisioning approval and the acceptance gates below |
| Isolated Linux backend | Disposable Linux environment with only approved source/runner input, private temporary output, required namespace sandbox and no host credentials or network | Ordinary WSL with Windows drive mounts, interop, host sockets or inherited secrets is not this isolation design; VM/container provisioning needs its own review and user authorization | Prefer for broader project execution when a genuinely isolated backend is available; no automatic provisioning or silent platform substitution |

OpenAI's [Windows sandbox guide](https://learn.chatgpt.com/docs/windows/windows-sandbox) describes an administrator-provisioned native mode using separate lower-privilege users and filesystem/network policy. Its fallback uses a restricted token derived from the current user. This is a useful architectural reference, not permission to provision this harness, reuse Codex accounts, or claim equivalent isolation. The public [setup orchestration](https://github.com/openai/codex/blob/822e58cc3d666166c7446c5b1ea2e52f5d09594c/codex-rs/windows-sandbox-rs/src/setup.rs), [privileged provisioning](https://github.com/openai/codex/blob/822e58cc3d666166c7446c5b1ea2e52f5d09594c/codex-rs/windows-sandbox-rs/src/setup_provisioning.rs), [service provisioning seam](https://github.com/openai/codex/blob/822e58cc3d666166c7446c5b1ea2e52f5d09594c/codex-rs/windows-sandbox-rs/src/setup_provisioning/service.rs) and [provisioning client](https://github.com/openai/codex/blob/822e58cc3d666166c7446c5b1ea2e52f5d09594c/codex-rs/windows-sandbox-rs/src/provisioning_client.rs) separate setup and service-owned decisions. Source revision inspected: `822e58cc3d666166c7446c5b1ea2e52f5d09594c`, verified against upstream `main` on 2026-10-06. These pinned references guide architecture; they are not a dependency or an accepted harness implementation.

## Planner preview

After building the runtime, the review-only CLI can produce a candidate plan using synthetic Windows paths:

```powershell
npm run windows:sandbox-plan -- --source 'C:\Projects\example' --private-state 'C:\ZetState\runtime.db' --private-state 'C:\ZetState\runtime.db-wal' --private-state 'C:\ZetState\runtime.db-shm' --work-area 'C:\ZetScratch'
```

The command writes JSON to stdout without local provisioning side effects. Its synthetic path proposal is not an attestation of a real Windows host, effective permissions, a protected store or network enforcement. Credential generation, account creation and apply are not implemented. Producing this JSON cannot approve privileged changes, sign an authorized apply operation or release the Windows execution hold.

A future setup would make persistent changes outside the workspace: an owned account/SID, a protected credential and identity-scoped policy/firewall resources. Deleting an account does not recreate its original SID; credential loss and interrupted provisioning may require manual recovery. User consent must explicitly cover these persistence and recovery risks. Any deny rule affects traffic under the exact new worker identity, so an existing user's SID must never be repurposed. The candidate creates its owned worker disabled; an approved execution may enable a necessary logon only after the exact identity and effective protections have been verified, then re-disable it. None of that setup is authorized or performed by the planner.

## Proposed native phases

### 1. Read-only preflight and reviewable plan

Inventory the Windows version, filesystem behavior, domain/GPO management, effective network policy, available logon APIs, required runner binaries and existing sandbox resources. Refuse unsupported or uninspectable conditions; do not repair machine policy during preflight.

Prepare a nonsecret plan bound to a fresh ownership identifier, machine identity, initiating user identity, exact workspace identity, source/runner digests, selected command family and short expiry. Include proposed account name, resulting SID recording procedure, protected-copy directory identities, exact rule identifiers and exact policy deltas. Existing names or resources with unproven ownership are collisions, not resources to adopt or overwrite.

Record protected before-state evidence and fingerprints for the particular objects that could change, including relevant account flags, memberships, user-right assignments and owned-directory security descriptors. The manifest should disclose the rollback steps and their conflict checks. It must not contain passwords, tokens, protected credential blobs or private source contents. Backups and ownership receipts remain in broker-private storage outside the model workspace.

A signed plan provides integrity and binds the reviewed proposal. It is not an approval token. The signer/key ownership and private storage need separate review; no persistent signing key is generated implicitly by a planner. Models cannot sign, approve or alter receipts. A privileged helper must validate both the plan and fresh human authorization, not merely a signature or possession of a path.

### 2. Action-time administrator and credential consent

Before each privileged apply stage, present the exact plan digest, resource identities, effects, expiry and rollback boundary to the initiating human. Obtain explicit action-time administrator authorization through an OS-supported trusted interaction. Revocation, cancellation, changed workspace/ownership, expired authorization or changed effective policy invalidates the operation. Do not lend an administrator token or generic privileged command channel to an agent.

Creating a persistent local identity and generating/storing its credential are separately disclosed actions. Neither is authorized by reviewing this document, a prior coding turn, a graph edge or a model request. A refusal leaves native project execution disabled and allows a separately approved isolated Linux option to be selected.

### 3. Owned disabled identity and protected credential

Create only a new owned nonadministrator offline account, disabled at rest. Do not reuse the real user, an existing sandbox account, a domain identity or another application's principal. Verify its resulting SID and effective groups/privileges; exclude administrator, backup/operator and other authority-bearing memberships. [Microsoft's local-account documentation](https://learn.microsoft.com/en-us/windows/security/identity-protection/access-control/local-accounts) provides the account-management baseline; the exact restricted membership policy is this proposed design.

After the explicit credential-generation/storage consent, generate a fresh unpredictable credential and place it only in an OS-protected store accessible to the trusted broker identity. The sandbox user, model, workspace, command environment, IPC results, plan and logs must not receive it. Evaluate current-user DPAPI under that broker identity with restrictive storage ACLs; do not treat machine-scope encryption as sufficient, since [Microsoft documents that machine-scope DPAPI can be decrypted by other users on that machine](https://learn.microsoft.com/en-us/windows/win32/api/dpapi/nf-dpapi-cryptprotectdata). Password rotation, broker recovery and protected-store teardown require their own exact ownership/consent rules.

A disabled account cannot simply be assumed usable for process logon. The eventual launcher must prove its chosen API/logon type and, if necessary, use a tightly bounded broker-controlled enable/logon/re-disable sequence only after protections are verified. Disabling the account does not invalidate already-issued tokens; JobObject teardown and process termination remain mandatory. No interactive desktop login is offered.

### 4. Minimum logon rights and scoped network controls

Grant only the right proven necessary for the selected noninteractive logon API to this exact owned SID. Batch logon is a candidate, not an assumed implementation: [Microsoft describes its separate user right and Group Policy precedence](https://learn.microsoft.com/en-us/previous-versions/windows/it-pro/windows-10/security/threat-protection/security-policy-settings/log-on-as-a-batch-job). Verify interactive, RDP and network-logon denial remains compatible with the chosen launch API. Do not grant debug, impersonation, backup, service or administrator authority to the sandbox user. Any privileged broker API requirement belongs to a narrowly scoped broker review, not the child account. Enterprise policy conflicts fail closed; do not rewrite global assignments, groups or GPO.

Use fresh owned network-rule identifiers and an identity-scoped enforcement mechanism verified on supported Windows builds. Deny external egress across profiles, address families and applicable protocols for the owned offline execution identity. Do not change global defaults, disable the firewall, add broad allow rules, delete existing rules, or substitute proxy/environment variables for kernel enforcement. [Microsoft's firewall rule documentation](https://learn.microsoft.com/en-us/windows/security/operating-system-security/network-security/windows-firewall/rules) explains rule precedence; effective policy must be checked rather than inferred from successful rule creation.

Loopback and local services are a distinct boundary. Prove denial of IPv4/IPv6 loopback, local listeners, DNS, SMB/UNC and unintended named-pipe/COM/RPC access with the actual execution token. If the chosen firewall mechanism cannot reliably cover the required local traffic, require an additional reviewed kernel mechanism or refuse the native backend. A narrowly authenticated broker pipe must not become a general localhost proxy or allow the model to call the runtime's privileged HTTP surfaces. No broker exception is authorized by this proposal.

### 5. Disposable copy and fixed broker launch

Keep the original workspace, source ACLs and private host paths unchanged. Never broaden original-source access or grant the new user access to runtime databases, credential stores, user profiles, signing material or broker receipts. Only broker-read, explicitly approved source entries enter a bounded disposable private copy. Reject reparse points, hard-link/private-path overlaps, case/identity changes, credential/Git metadata and unexpected files. Protect the copy's ancestry from replacement; give the execution user only required rights on owned staging objects.

A dedicated user alone still receives access through `Everyone`, `Users` and `Authenticated Users`. The candidate therefore needs a separately reviewed and kernel-proved restricting-SID/token policy, with only owned scratch/tool read-execute grants and scratch write grants. Before every launch, prove denial for original source, existing private state, future sidecars and ordinary file creation with the actual execution token. No proposed setup may relax the current bridge, bypass a failing AppContainer setter (including error 1314), or assume provisioning repairs that failure. Any required original-source/private ACL mutation is blocked by this design and would require a new explicit review and authorization.

The token design must enforce restricting-SID checks for reads and writes, prohibit `WRITE_RESTRICTED` and `SANDBOX_INERT`, and read back the exact nonempty restricting SID set, groups and privileges. Never add `Everyone`, `Users`, `Authenticated Users` or a broad logon SID to the restricting set to make tool loading succeed. Existing restrictions intersect; a privilege-disabling flag does not prove every privilege was removed. [Microsoft documents these token semantics](https://learn.microsoft.com/en-us/windows/win32/api/securitybaseapi/nf-securitybaseapi-createrestrictedtoken), including the retained `SeChangeNotifyPrivilege` under `DISABLE_MAX_PRIVILEGE`. Cross-user launch privileges need separate trusted-broker review; the same-user restricted-token `CreateProcessAsUser` exception does not prove dedicated-account launch.

Future-object proof must use this candidate token. Existing AppContainer evidence involving a Low child and Medium objects with no-write-up policy cannot establish denial for a dedicated worker at Medium integrity. Prove inherited file and directory reads and every mutation, ownership, default/null/conditional DACL behavior and inheritance closure; refuse unsupported shapes. Any Low-token alternative needs fresh descendant and token-policy proof and remains subject to the existing 1314 hold. No original-source or private ACL repair is authorized.

Windows-wide ambient access cannot be solved by denying a short list of known paths. Require an explicit threat model and effective-token probes for readable/writable host resources. Broadly readable private data or local services may make this backend unsuitable. Do not mutate unrelated host ACLs to make a probe pass; choose stronger isolation or refuse execution.

The trusted broker validates exact command family, executable identity/hash, argv, working directory, environment, source snapshot and deadlines. Project scripts are executable project code even when named `test`; their arbitrary child behavior must remain contained. Do not expose unrestricted PowerShell, shell text, arbitrary executables or privileged broker verbs. Use a minimal environment without inherited provider credentials, Git credentials, profiles, agents, proxies, inherited handles or personal configuration. No dependency downloads, automatic package lifecycle installation or network fallback occur.

Create the child suspended, apply the selected restricted identity/token, deny unintended handle inheritance, assign it to a non-breakaway kill-on-close JobObject and validate containment before allowing any project instruction to run. Require a private noninteractive window station and desktop; Microsoft warns that restricted applications on the default desktop can attack unrestricted applications through window messages. Do not broaden the user's desktop ACLs for compatibility. [Microsoft's JobObject documentation](https://learn.microsoft.com/en-us/windows/win32/procthread/job-objects) provides lifecycle mechanisms, not a claim that job membership prevents filesystem or network access. Bound CPU/time, process count, memory and output. Cancellation or broker death must terminate descendants and invalidate further command authorization. Return bounded diagnostics only; writeback to original source requires a separate reviewed diff and exact normal harness mutation approvals.

### 6. Verification before availability

Before enabling the backend, independently review source, the privileged protocol, token construction, credential isolation, race handling and cleanup. Run fresh exact-commit Windows kernel tests on disposable machines for the actual new identity and launch path, including:

- denied reads/writes to existing and future private files; reparse/hard-link/ancestry races and source immutability;
- external/loopback IPv4/IPv6, DNS, SMB and privileged local IPC denial, effective policy drift and conflicting GPO;
- actual nonadministrator groups/privileges and logon rights; disabled-account lifecycle and credential-store denial;
- job-before-execution, breakaway/handle inheritance, detached descendants, cancellation, timeout and broker crash;
- bounded project scripts and hostile child processes without credentials or network fallback;
- denied/stale apply consent, receipt tampering, changed ownership, interrupted provisioning and concurrent administrator changes;
- exact teardown and recovery with no deletion of unrelated objects and no reopening access after partial failure.

Fixtures and source review cannot substitute for kernel proof. Even passing tests do not authorize applying this design to a user's real machine. Availability needs a reviewed implementation, fresh platform acceptance and separate user provisioning consent; this document meets none of those gates.

## Exact teardown and rollback

Stop admitting commands and invalidate pending authorizations first, then disable the exact owned account. Kill and wait for owned jobs/descendants, close owned IPC/handles and verify no execution remains. Keep network protections until containment is confirmed; if process termination or identity verification is uncertain, fail closed and require recovery rather than removing protections.

Remove only resources named by protected receipts whose current SID/file identity/rule identity and expected state still match ownership. Remove only this operation's user-right/group deltas, exact owned network filters, owned credentials, owned private copy and, when explicitly approved, the matching owned account. An account-name match alone is insufficient. Never use broad firewall resets, account-prefix deletion, recursive deletion of unverified paths, blanket ACL restores, or full policy import as cleanup.

Rollback applies a conditional inverse to the exact recorded owned changes. If another administrator changed a membership, rule, descriptor or policy concurrently, stop that step and report the conflict; do not overwrite newer state with the backup. Retain a bounded nonsecret recovery receipt outside the workspace and offer review of the remaining owned resources. Cleaning up a failed operation must not silently recreate credentials, re-enable logon, widen host access or grant capabilities.

## Isolated Linux alternative

Select an existing trusted Linux execution host or a separately reviewed disposable VM/container arrangement. Do not install WSL, enable virtualization, create accounts or change machine policy automatically. A Windows UI may talk to a narrowly scoped authenticated broker, while providers remain in the main harness and executable payloads receive no provider credentials.

Use immutable approved source and trusted runners only; no original Windows source/profile/database mounts, drive automount, Windows executable interop, host sockets or secret-agent forwarding. Require a private temporary workspace, required namespace isolation, no network and the same exact command/cancellation/output limits. Verify any host integration is unavailable to payloads. Results are bounded diagnostics or a separately reviewed diff, never automatic source writeback. The existing Linux sandbox evidence helps assess this option but does not establish a new Windows-to-Linux broker or VM deployment as implemented or accepted.

The review decision should record which backend can meet these boundaries on the target machine. If neither can, project execution remains unavailable; the harness must not quietly fall back to the interactive user's shell or a weaker isolation mode.

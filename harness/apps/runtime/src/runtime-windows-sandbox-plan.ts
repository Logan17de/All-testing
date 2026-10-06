import { win32 } from "node:path";

export interface WindowsSandboxPlanInput {
  readonly backend: "dedicated-user";
  readonly sourceRoot: string;
  readonly privateStatePaths: readonly string[];
  readonly disposableWorkArea: string;
}
export type WindowsSandboxSetupActionId =
  | "review-admin-boundaries"
  | "create-dedicated-account"
  | "protect-private-credentials"
  | "restrict-logon-policy"
  | "configure-network-denial"
  | "configure-workarea-acls"
  | "verify-isolation";
export type WindowsSandboxRollbackActionId =
  | "disable-dispatch"
  | "revoke-dedicated-logon"
  | "stop-owned-processes"
  | "remove-disposable-workarea"
  | "restore-recorded-acls"
  | "restore-recorded-firewall-policy"
  | "restore-recorded-logon-policy"
  | "remove-private-credentials"
  | "remove-dedicated-account";
export interface WindowsSandboxReviewAction<Id extends string> {
  readonly id: Id;
  readonly description: string;
  readonly requiresExplicitHumanApproval: true;
}
export interface WindowsSandboxPreparationPlan {
  readonly version: 1;
  readonly backend: "dedicated-user";
  readonly availability: "disabled";
  readonly executionAuthority: "none";
  readonly purpose: "human-review-only";
  readonly pathStatus: "lexical-candidates-only";
  readonly blockers: readonly Readonly<{
    id: "dispatch-disabled" | "human-approval-required" | "native-acceptance-pending";
    description: string;
  }>[];
  readonly paths: WindowsSandboxPlanInput;
  readonly prerequisites: {
    readonly version: 1;
    readonly items: readonly Readonly<{ id: string; description: string }>[];
  };
  readonly setup: readonly WindowsSandboxReviewAction<WindowsSandboxSetupActionId>[];
  readonly rollback: readonly WindowsSandboxReviewAction<WindowsSandboxRollbackActionId>[];
}

function refused(): never {
  throw new Error("Invalid Windows sandbox preparation proposal.");
}
/** Lexical canonicality only. This pure module cannot attest filesystem identities or ACLs. */
function canonicalPath(value: unknown): string {
  if (typeof value !== "string" || value.length > 4096 || !/^[A-Z]:\\/.test(value)) refused();
  if (/[\u0000-\u001f\u007f]/.test(value) || value.slice(2).includes(":")) refused();
  if (
    !win32.isAbsolute(value) ||
    win32.normalize(value) !== value ||
    value === win32.parse(value).root
  )
    refused();
  const segments = value.slice(3).split("\\");
  if (
    segments.some(
      (segment) =>
        !segment ||
        /[<>"|?*\/]/.test(segment) ||
        /[. ]$/.test(segment) ||
        /^(?:con|prn|aux|nul|conin\$|conout\$|com[1-9¹²³]|lpt[1-9¹²³])(?:\.|$)/i.test(segment),
    )
  )
    refused();
  return value;
}
function overlaps(left: string, right: string): boolean {
  // A proposal conservatively treats case variants as aliases; it makes no volume claims.
  const a = left.toUpperCase(),
    b = right.toUpperCase();
  return a === b || a.startsWith(`${b}\\`) || b.startsWith(`${a}\\`);
}
function action<Id extends string>(id: Id, description: string): WindowsSandboxReviewAction<Id> {
  return Object.freeze({ id, description, requiresExplicitHumanApproval: true });
}

/** A deterministic proposal, never an execution grant. Imported manifests have no authority. */
export function createWindowsSandboxPreparationPlan(
  input: WindowsSandboxPlanInput,
): WindowsSandboxPreparationPlan {
  if (!input || typeof input !== "object" || Array.isArray(input)) refused();
  if (
    Object.keys(input).some(
      (key) => !["backend", "sourceRoot", "privateStatePaths", "disposableWorkArea"].includes(key),
    ) ||
    input.backend !== "dedicated-user"
  )
    refused();
  const sourceRoot = canonicalPath(input.sourceRoot);
  const disposableWorkArea = canonicalPath(input.disposableWorkArea);
  if (
    !Array.isArray(input.privateStatePaths) ||
    input.privateStatePaths.length === 0 ||
    input.privateStatePaths.length > 16
  )
    refused();
  const privateStatePaths = input.privateStatePaths.map(canonicalPath).sort();
  const all = [sourceRoot, disposableWorkArea, ...privateStatePaths];
  for (let i = 0; i < all.length; i++)
    for (let j = i + 1; j < all.length; j++) if (overlaps(all[i]!, all[j]!)) refused();
  const paths = Object.freeze({
    backend: "dedicated-user" as const,
    sourceRoot,
    disposableWorkArea,
    privateStatePaths: Object.freeze(privateStatePaths),
  });
  const prerequisites = Object.freeze({
    version: 1 as const,
    items: Object.freeze([
      Object.freeze({
        id: "trusted-administrator-review",
        description:
          "A human administrator must review each privileged change and its recorded rollback. Any future apply needs a digest-bound fresh approval and current machine, account SID, path identities and generation; imported plans confer no authority.",
      }),
      Object.freeze({
        id: "filesystem-identity-attestation",
        description:
          "A trusted host must independently attest real canonical paths, alias/reparse-point absence, volume identity, trusted tool roots and private-state exclusions; lexical validation is insufficient. Disposable work must not overlap any trusted tool root.",
      }),
      Object.freeze({
        id: "dedicated-identity-and-secret-storage",
        description:
          "Use a separately approved dedicated account and private credential storage; account creation and persistent credentials require explicit human confirmation.",
      }),
      Object.freeze({
        id: "restricted-token-and-unmodified-host-denial",
        description:
          "A dedicated identity alone does not deny ambient Everyone/Users grants. Separately prove a restricted-SID least-privilege token, owned scratch/tool-only ACL grants and actual original-source/private/future denial without modifying original source or private ACLs. Reject WRITE_RESTRICTED and SANDBOX_INERT, verify exact nonempty restricting SIDs and actual groups/privileges, and never add broad Everyone/Users/Authenticated Users/logon SIDs to the restricting pass. Require a private desktop and recompute future-file/directory read and mutation denial for the actual candidate token. Refuse the candidate if host ACL edits are required. No TCB, backup, restore or debug privileges; agents never receive administrator/helper authority. DISABLE_MAX_PRIVILEGE retains SeChangeNotifyPrivilege, so verify every retained privilege. Require a separately attested cross-user launch mechanism; ordinary daemon execution proves neither broker privileges nor worker isolation.",
      }),
      Object.freeze({
        id: "separate-unimplemented-backend",
        description:
          "This is a distinct unimplemented candidate, not a repair or approval for the existing AppContainer privilege failure. No native execution capability is established by setup descriptions.",
      }),
      Object.freeze({
        id: "verified-isolation-and-recovery",
        description:
          "Independently verify logon restrictions, network denial, ACL confinement, process cancellation and recovery on the target Windows host before enabling any backend.",
      }),
    ]),
  });
  return Object.freeze({
    version: 1,
    backend: "dedicated-user",
    availability: "disabled",
    executionAuthority: "none",
    purpose: "human-review-only",
    pathStatus: "lexical-candidates-only",
    blockers: Object.freeze([
      Object.freeze({
        id: "dispatch-disabled" as const,
        description:
          "No dedicated-user execution backend or apply API is enabled by this proposal.",
      }),
      Object.freeze({
        id: "human-approval-required" as const,
        description:
          "Every privileged setup action and persistent credential change requires separate explicit human approval.",
      }),
      Object.freeze({
        id: "native-acceptance-pending" as const,
        description:
          "Fresh machine, SID, path and trusted-tool identity attestation plus native isolation acceptance remain required.",
      }),
    ]),
    paths,
    prerequisites,
    setup: Object.freeze([
      action(
        "review-admin-boundaries",
        "Review required administrator boundaries and record existing policy/ACL state plus the exact changes approved by the human.",
      ),
      action(
        "create-dedicated-account",
        "Request explicit approval for creation of a dedicated local account; do not create an account from this proposal.",
      ),
      action(
        "protect-private-credentials",
        "Request separate confirmation for persistent credentials and approved private storage; never include credentials in this manifest.",
      ),
      action(
        "restrict-logon-policy",
        "Review a dedicated-account logon policy that prevents interactive and remote use except the narrowly approved execution mechanism.",
      ),
      action(
        "configure-network-denial",
        "Review administrator-managed firewall denial for the dedicated identity, including inherited rules and restoration of the recorded prior policy.",
      ),
      action(
        "configure-workarea-acls",
        "Review transaction-owned scratch and trusted-tool ACL grants only. Prove original source, runtime private state, future host objects and credential locations remain inaccessible without editing their ACLs; refuse if original/private ACL edits are necessary.",
      ),
      action(
        "verify-isolation",
        "Require independent native isolation and cancellation tests; this proposal remains disabled and cannot authorize execution.",
      ),
    ]),
    rollback: Object.freeze([
      action(
        "disable-dispatch",
        "Disable backend dispatch and invalidate outstanding execution grants before starting rollback.",
      ),
      action(
        "revoke-dedicated-logon",
        "Disable new logon for only the transaction-owned account SID before terminating its jobs; halt and report any identity or policy drift.",
      ),
      action(
        "stop-owned-processes",
        "Stop and verify termination of only transaction-owned processes bound to the recorded dedicated account SID.",
      ),
      action(
        "remove-disposable-workarea",
        "Remove only the verified owned disposable copy after processes and handles are closed.",
      ),
      action(
        "restore-recorded-acls",
        "Compare current state with the transaction record and remove only transaction-owned ACL ACEs; halt and report drift, never reset a whole ACL or overwrite unrelated changes.",
      ),
      action(
        "restore-recorded-firewall-policy",
        "Compare current state and remove only transaction-owned firewall rule GUIDs; halt and report drift; preserve unrelated rules and changes.",
      ),
      action(
        "restore-recorded-logon-policy",
        "Compare current state and undo only transaction-owned logon-policy rights for the recorded account SID; halt and report drift.",
      ),
      action(
        "remove-private-credentials",
        "Remove the approved dedicated credential material from its private storage without logging it.",
      ),
      action(
        "remove-dedicated-account",
        "Request explicit administrator approval to remove only the transaction-created account with the recorded SID; never remove a preexisting or same-name replacement account.",
      ),
    ]),
  });
}

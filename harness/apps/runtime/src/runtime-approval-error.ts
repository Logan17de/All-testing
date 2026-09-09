export type RuntimeApprovalErrorCode =
  | "APPROVAL_NOT_FOUND"
  | "APPROVAL_INVALID_REQUEST"
  | "APPROVAL_INVALID_TOKEN"
  | "APPROVAL_EXPIRED"
  | "APPROVAL_CONFLICT"
  | "APPROVAL_RUN_NOT_QUIESCENT"
  | "APPROVAL_UNSUPPORTED_GRAPH"
  | "PERMISSION_DENIED";

const MESSAGES: Readonly<Record<RuntimeApprovalErrorCode, string>> = Object.freeze({
  APPROVAL_NOT_FOUND: "The approval does not exist.",
  APPROVAL_INVALID_REQUEST: "The approval request is invalid or contains protected material.",
  APPROVAL_INVALID_TOKEN: "The resume token is invalid.",
  APPROVAL_EXPIRED: "The approval has expired.",
  APPROVAL_CONFLICT: "The request conflicts with the durable approval or run state.",
  APPROVAL_RUN_NOT_QUIESCENT: "Drain active execution before suspending the run.",
  APPROVAL_UNSUPPORTED_GRAPH: "Human approval currently requires an iteration-zero plain DAG gate.",
  PERMISSION_DENIED: "Current host permission policy does not authorize this operation.",
});

export class RuntimeApprovalError extends Error {
  readonly code: RuntimeApprovalErrorCode;
  readonly statusCode: number;
  readonly remediation: string;

  constructor(code: RuntimeApprovalErrorCode) {
    super(MESSAGES[code]);
    this.name = "RuntimeApprovalError";
    this.code = code;
    this.statusCode =
      code === "APPROVAL_NOT_FOUND"
        ? 404
        : code === "APPROVAL_INVALID_REQUEST"
          ? 400
          : code === "APPROVAL_INVALID_TOKEN" || code === "PERMISSION_DENIED"
            ? 403
            : 409;
    this.remediation =
      code === "PERMISSION_DENIED"
        ? "request-host-authorization"
        : code === "APPROVAL_INVALID_TOKEN"
          ? "obtain-current-resume-token"
          : "reload-durable-approval-state";
  }
}

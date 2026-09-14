import { guardLocalRequest, readJsonObject, relay } from "../../../../../lib/local-request-guard";
import { postToRuntime } from "../../../../../lib/runtime-client";

export const dynamic = "force-dynamic";

/**
 * Record a human decision on a pending approval.
 *
 * The daemon requires a fresh single-use resume token per decision. It is issued
 * and spent here, on the server, in one step, so the token never reaches the
 * browser, a URL, or anything the page can log.
 */
export async function POST(
  request: Request,
  context: { readonly params: Promise<{ id: string }> },
) {
  const rejected = guardLocalRequest(request, "mutation");
  if (rejected !== undefined) return rejected;
  const body = await readJsonObject(request);
  if (body instanceof Response) return body;

  const decision = body["decision"];
  if (decision !== "approved" && decision !== "rejected") {
    return Response.json(
      {
        error: {
          code: "APPROVAL_INVALID_DECISION",
          reason: "decision must be 'approved' or 'rejected'.",
        },
      },
      { status: 400 },
    );
  }

  const { id } = await context.params;
  const path = `/api/approvals/${encodeURIComponent(id)}`;

  const issued = await postToRuntime(`${path}/token`, {});
  const token =
    typeof issued.body === "object" && issued.body !== null && "resumeToken" in issued.body
      ? (issued.body as { readonly resumeToken: unknown }).resumeToken
      : undefined;
  if (issued.status !== 200 || typeof token !== "string") {
    // A failed issue carries an error, never a token, so relaying it leaks nothing.
    return relay(issued);
  }

  return relay(
    await postToRuntime(`${path}/resume`, {
      resumeToken: token,
      decision,
      payload: body["payload"] ?? null,
    }),
  );
}

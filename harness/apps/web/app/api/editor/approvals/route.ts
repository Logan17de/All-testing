import { guardLocalRequest, relay } from "../../../../lib/local-request-guard";
import { getFromRuntime } from "../../../../lib/runtime-client";

export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  const rejected = guardLocalRequest(request, "read");
  if (rejected !== undefined) return rejected;
  const runId = new URL(request.url).searchParams.get("runId");
  if (runId === null || runId.length === 0) {
    return Response.json(
      { error: { code: "APPROVAL_RUN_REQUIRED", reason: "Pass ?runId= to list approvals." } },
      { status: 400 },
    );
  }
  return relay(await getFromRuntime(`/api/approvals?runId=${encodeURIComponent(runId)}`));
}

import {
  guardLocalRequest,
  readJsonObject,
  relay,
} from "../../../../../../lib/local-request-guard";
import { postToRuntime } from "../../../../../../lib/runtime-client";

export const dynamic = "force-dynamic";

/**
 * Start a new run from a point in this run's history.
 *
 * The run being forked from is never changed. With no `throughEventId` the fork is
 * cut at that run's latest event, which is what the inspector's Fork button sends.
 */
export async function POST(
  request: Request,
  context: { readonly params: Promise<{ id: string }> },
) {
  const rejected = guardLocalRequest(request, "mutation");
  if (rejected !== undefined) return rejected;
  const body = await readJsonObject(request);
  if (body instanceof Response) return body;

  const throughEventId = body["throughEventId"];
  const { id } = await context.params;
  return relay(
    await postToRuntime(
      `/api/runs/${encodeURIComponent(id)}/fork`,
      throughEventId === undefined ? {} : { throughEventId },
    ),
  );
}

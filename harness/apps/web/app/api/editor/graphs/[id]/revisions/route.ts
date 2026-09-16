import { guardLocalRequest, relay } from "../../../../../../lib/local-request-guard";
import { getFromRuntime } from "../../../../../../lib/runtime-client";

export const dynamic = "force-dynamic";

/** The revisions of one graph that were actually run. */
export async function GET(request: Request, context: { readonly params: Promise<{ id: string }> }) {
  const rejected = guardLocalRequest(request, "read");
  if (rejected !== undefined) return rejected;
  const { id } = await context.params;
  return relay(await getFromRuntime(`/api/graphs/${encodeURIComponent(id)}/revisions`));
}

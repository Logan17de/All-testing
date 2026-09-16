import { guardLocalRequest, relay } from "../../../../../../lib/local-request-guard";
import { getFromRuntime } from "../../../../../../lib/runtime-client";

export const dynamic = "force-dynamic";

/** A read-only replay of a run's recorded journal; it runs nothing. */
export async function GET(request: Request, context: { readonly params: Promise<{ id: string }> }) {
  const rejected = guardLocalRequest(request, "read");
  if (rejected !== undefined) return rejected;
  const { id } = await context.params;
  return relay(await getFromRuntime(`/api/runs/${encodeURIComponent(id)}/replay`));
}

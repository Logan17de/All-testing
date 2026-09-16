import { guardLocalRequest, relay } from "../../../../../../lib/local-request-guard";
import { getFromRuntime } from "../../../../../../lib/runtime-client";

export const dynamic = "force-dynamic";

/** What changed between two stored revisions of one graph. */
export async function GET(request: Request, context: { readonly params: Promise<{ id: string }> }) {
  const rejected = guardLocalRequest(request, "read");
  if (rejected !== undefined) return rejected;
  const { id } = await context.params;
  const url = new URL(request.url);
  const from = url.searchParams.get("from") ?? "";
  const to = url.searchParams.get("to") ?? "";
  return relay(
    await getFromRuntime(
      `/api/graphs/${encodeURIComponent(id)}/diff?from=${encodeURIComponent(from)}&to=${encodeURIComponent(to)}`,
    ),
  );
}

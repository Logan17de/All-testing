import { guardLocalRequest, readJsonObject, relay } from "../../../../lib/local-request-guard";
import { postToRuntime } from "../../../../lib/runtime-client";

export const dynamic = "force-dynamic";

export async function POST(request: Request) {
  const rejected = guardLocalRequest(request, "mutation");
  if (rejected !== undefined) return rejected;
  const body = await readJsonObject(request);
  if (body instanceof Response) return body;
  // Forward only the graph, never whatever else a caller put in the body.
  return relay(await postToRuntime("/api/graphs/validate", { graph: body["graph"] ?? null }));
}

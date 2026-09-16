import { guardLocalRequest, readJsonObject, relay } from "../../../../lib/local-request-guard";
import { getFromRuntime, mutateRuntime } from "../../../../lib/runtime-client";

export const dynamic = "force-dynamic";

/** The models this harness can call. Keys are never part of the answer. */
export async function GET(request: Request) {
  const rejected = guardLocalRequest(request, "read");
  if (rejected !== undefined) return rejected;
  return relay(await getFromRuntime("/api/models"));
}

/** Connect a model: an endpoint, the model it serves, and a key when it needs one. */
export async function POST(request: Request) {
  const rejected = guardLocalRequest(request, "mutation");
  if (rejected !== undefined) return rejected;
  const body = await readJsonObject(request);
  if (body instanceof Response) return body;
  return relay(await mutateRuntime("/api/models", "POST", body));
}

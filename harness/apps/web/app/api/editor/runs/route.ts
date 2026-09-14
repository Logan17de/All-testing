import { guardLocalRequest, readJsonObject, relay } from "../../../../lib/local-request-guard";
import { getFromRuntime, postToRuntime } from "../../../../lib/runtime-client";

export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  const rejected = guardLocalRequest(request, "read");
  if (rejected !== undefined) return rejected;
  return relay(await getFromRuntime("/api/runs"));
}

export async function POST(request: Request) {
  const rejected = guardLocalRequest(request, "mutation");
  if (rejected !== undefined) return rejected;
  const body = await readJsonObject(request);
  if (body instanceof Response) return body;
  return relay(await postToRuntime("/api/runs", { graph: body["graph"] ?? null }));
}

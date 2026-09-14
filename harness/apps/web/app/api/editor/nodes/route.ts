import { guardLocalRequest, relay } from "../../../../lib/local-request-guard";
import { getFromRuntime } from "../../../../lib/runtime-client";

export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  const rejected = guardLocalRequest(request, "read");
  if (rejected !== undefined) return rejected;
  return relay(await getFromRuntime("/api/nodes"));
}

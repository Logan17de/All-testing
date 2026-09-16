import { guardLocalRequest, readJsonObject, relay } from "../../../../../lib/local-request-guard";
import { mutateRuntime } from "../../../../../lib/runtime-client";

export const dynamic = "force-dynamic";

/**
 * Install a plugin package from npm or an https Git repository.
 *
 * The runtime decides everything that matters: whether this harness installs at all,
 * whether the source is acceptable, and whether what arrived is a plugin. It runs no
 * shell and no package hooks, and the package arrives disabled with nothing granted.
 */
export async function POST(request: Request) {
  const rejected = guardLocalRequest(request, "mutation");
  if (rejected !== undefined) return rejected;
  const body = await readJsonObject(request);
  if (body instanceof Response) return body;
  return relay(await mutateRuntime("/api/plugins/install", "POST", body));
}

import { guardLocalRequest, relay } from "../../../../../../lib/local-request-guard";
import { runtimeModelPath } from "../../../../../../lib/model-routes";
import { mutateRuntime } from "../../../../../../lib/runtime-client";

export const dynamic = "force-dynamic";

/** Ask a configured model to answer, which proves the endpoint, the key and the model name. */
export async function POST(
  request: Request,
  context: { readonly params: Promise<{ id: string }> },
) {
  const rejected = guardLocalRequest(request, "mutation");
  if (rejected !== undefined) return rejected;
  const path = runtimeModelPath((await context.params).id, "check");
  if (path === undefined) {
    return Response.json(
      { error: { code: "LOCAL_UI_NOT_FOUND", reason: "No such model endpoint." } },
      { status: 404, headers: { "cache-control": "no-store" } },
    );
  }
  return relay(await mutateRuntime(path, "POST", {}));
}

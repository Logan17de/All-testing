import { guardLocalRequest, readJsonObject, relay } from "../../../../../lib/local-request-guard";
import { runtimeModelPath } from "../../../../../lib/model-routes";
import { mutateRuntime } from "../../../../../lib/runtime-client";

export const dynamic = "force-dynamic";

interface ModelContext {
  readonly params: Promise<{ id: string }>;
}

function notFound(): Response {
  return Response.json(
    { error: { code: "LOCAL_UI_NOT_FOUND", reason: "No such model endpoint." } },
    { status: 404, headers: { "cache-control": "no-store" } },
  );
}

/** Change a configured model; an absent key keeps the one that is stored. */
export async function PATCH(request: Request, context: ModelContext) {
  const rejected = guardLocalRequest(request, "mutation");
  if (rejected !== undefined) return rejected;
  const path = runtimeModelPath((await context.params).id);
  if (path === undefined) return notFound();
  const body = await readJsonObject(request);
  if (body instanceof Response) return body;
  return relay(await mutateRuntime(path, "PATCH", body));
}

/** Remove a configured model, and its stored key with it. */
export async function DELETE(request: Request, context: ModelContext) {
  const rejected = guardLocalRequest(request, "mutation");
  if (rejected !== undefined) return rejected;
  const path = runtimeModelPath((await context.params).id);
  if (path === undefined) return notFound();
  return relay(await mutateRuntime(path, "DELETE"));
}

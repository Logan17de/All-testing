import { guardLocalRequest, readJsonObject, relay } from "../../../../../lib/local-request-guard";
import { runtimeMemoryPath } from "../../../../../lib/memory-routes";
import { mutateRuntime } from "../../../../../lib/runtime-client";

export const dynamic = "force-dynamic";

interface MemoryContext {
  readonly params: Promise<{ id: string }>;
}

function notFound(): Response {
  return Response.json(
    { error: { code: "LOCAL_UI_NOT_FOUND", reason: "No such memory endpoint." } },
    { status: 404, headers: { "cache-control": "no-store" } },
  );
}

/** Change one memory: its text, its kind, or whether it is pinned. */
export async function PATCH(request: Request, context: MemoryContext) {
  const rejected = guardLocalRequest(request, "mutation");
  if (rejected !== undefined) return rejected;
  const { id } = await context.params;
  const path = runtimeMemoryPath(id);
  if (path === undefined) return notFound();
  const body = await readJsonObject(request);
  if (body instanceof Response) return body;
  return relay(await mutateRuntime(path, "PATCH", body));
}

/** Forget one memory outright; the harness keeps no quiet copy of it. */
export async function DELETE(request: Request, context: MemoryContext) {
  const rejected = guardLocalRequest(request, "mutation");
  if (rejected !== undefined) return rejected;
  const { id } = await context.params;
  const path = runtimeMemoryPath(id);
  if (path === undefined) return notFound();
  return relay(await mutateRuntime(path, "DELETE"));
}

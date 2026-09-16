import {
  guardLocalRequest,
  readJsonObject,
  relay,
} from "../../../../../../lib/local-request-guard";
import { runtimeProjectMemoriesPath } from "../../../../../../lib/memory-routes";
import { getFromRuntime, mutateRuntime } from "../../../../../../lib/runtime-client";

export const dynamic = "force-dynamic";

interface ProjectContext {
  readonly params: Promise<{ id: string }>;
}

function notFound(): Response {
  return Response.json(
    { error: { code: "LOCAL_UI_NOT_FOUND", reason: "No such memory endpoint." } },
    { status: 404, headers: { "cache-control": "no-store" } },
  );
}

/** What this project remembers, in recall order: pinned first, then most recently changed. */
export async function GET(request: Request, context: ProjectContext) {
  const rejected = guardLocalRequest(request, "read");
  if (rejected !== undefined) return rejected;
  const { id } = await context.params;
  const path = runtimeProjectMemoriesPath(id, new URL(request.url).searchParams);
  if (path === undefined) return notFound();
  return relay(await getFromRuntime(path));
}

/** Write something down for this project to remember. */
export async function POST(request: Request, context: ProjectContext) {
  const rejected = guardLocalRequest(request, "mutation");
  if (rejected !== undefined) return rejected;
  const { id } = await context.params;
  const path = runtimeProjectMemoriesPath(id, new URLSearchParams());
  if (path === undefined) return notFound();
  const body = await readJsonObject(request);
  if (body instanceof Response) return body;
  return relay(await mutateRuntime(path, "POST", body));
}

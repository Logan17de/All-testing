import { guardLocalRequest, readJsonObject, relay } from "../../../../../lib/local-request-guard";
import { getFromRuntime, postToRuntime } from "../../../../../lib/runtime-client";
import { runtimeWorkspacePath } from "../../../../../lib/workspace-routes";

export const dynamic = "force-dynamic";

interface WorkspaceContext {
  readonly params: Promise<{ path: string[] }>;
}

async function target(request: Request, context: WorkspaceContext): Promise<string | Response> {
  const { path } = await context.params;
  const runtimePath = runtimeWorkspacePath(path, new URL(request.url).searchParams);
  return (
    runtimePath ??
    Response.json(
      { error: { code: "LOCAL_UI_NOT_FOUND", reason: "No such workspace endpoint." } },
      { status: 404, headers: { "cache-control": "no-store" } },
    )
  );
}

export async function GET(request: Request, context: WorkspaceContext) {
  const rejected = guardLocalRequest(request, "read");
  if (rejected !== undefined) return rejected;
  const runtimePath = await target(request, context);
  if (runtimePath instanceof Response) return runtimePath;
  return relay(await getFromRuntime(runtimePath));
}

export async function POST(request: Request, context: WorkspaceContext) {
  const rejected = guardLocalRequest(request, "mutation");
  if (rejected !== undefined) return rejected;
  const runtimePath = await target(request, context);
  if (runtimePath instanceof Response) return runtimePath;
  const body = await readJsonObject(request);
  if (body instanceof Response) return body;
  return relay(await postToRuntime(runtimePath, body));
}

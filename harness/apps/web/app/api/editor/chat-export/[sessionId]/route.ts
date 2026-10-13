import { guardLocalRequest, relay } from "../../../../../lib/local-request-guard";
import { getFromRuntime, postToRuntime } from "../../../../../lib/runtime-client";
import { isSortableId } from "../../../../../lib/ids";
import { readableChatExport } from "../../../../agent/chat-export";

export const dynamic = "force-dynamic";
export async function GET(request: Request, context: { params: Promise<{ sessionId: string }> }) {
  const rejected = guardLocalRequest(request, "read");
  if (rejected) return rejected;
  const { sessionId } = await context.params;
  if (!isSortableId(sessionId))
    return Response.json({ error: { reason: "Invalid chat ID." } }, { status: 400 });
  const snapshot = await getFromRuntime("/api/agent");
  if (snapshot.status !== 200) return relay(snapshot);
  const features = (snapshot.body as { sessionFeatures?: { export?: boolean } } | null)
    ?.sessionFeatures;
  if (features?.export !== true)
    return Response.json(
      { error: { reason: "Transcript export unavailable: runtime update required." } },
      { status: 409, headers: { "cache-control": "no-store" } },
    );
  const result = await postToRuntime("/api/agent", {
    action: "session/export",
    params: { sessionId },
  });
  if (result.status !== 200) return relay(result);
  try {
    const file = readableChatExport((result.body as { result?: unknown } | null)?.result);
    return new Response(file.content, {
      headers: {
        "content-type": file.mediaType,
        "content-disposition": `attachment; filename="${file.filename}"`,
        "cache-control": "no-store",
        "x-content-type-options": "nosniff",
      },
    });
  } catch {
    return Response.json(
      { error: { reason: "The runtime returned an invalid readable chat export." } },
      { status: 502, headers: { "cache-control": "no-store" } },
    );
  }
}

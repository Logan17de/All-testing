import { guardLocalRequest } from "../../../../../../lib/local-request-guard";
import { runtimeOrigin } from "../../../../../../lib/runtime-client";

export const dynamic = "force-dynamic";
export async function GET(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const rejected = guardLocalRequest(request, "read");
  if (rejected) return rejected;
  const { id } = await params;
  const query = new URL(request.url).searchParams;
  const generation = query.get("generation");
  if (
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u.test(id) ||
    generation === null ||
    !/^\d{1,12}$/u.test(generation) ||
    [...query.keys()].some((key) => key !== "generation")
  )
    return Response.json({ error: { code: "INVALID_LOCAL_CAPTURE" } }, { status: 400 });
  try {
    const response = await fetch(
      new URL(`/api/desktop/artifacts/${id}?generation=${generation}`, runtimeOrigin()),
      { cache: "no-store", redirect: "error", signal: AbortSignal.timeout(10_000) },
    );
    if (!response.ok || response.headers.get("content-type") !== "image/png" || !response.body)
      return Response.json({ error: { code: "LOCAL_CAPTURE_UNAVAILABLE" } }, { status: 404 });
    const reader = response.body.getReader();
    const chunks: Uint8Array[] = [];
    let length = 0;
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        length += value.byteLength;
        if (length > 32 * 1024 * 1024) {
          await reader.cancel();
          throw new Error();
        }
        chunks.push(value);
      }
    } finally {
      reader.releaseLock();
    }
    const bytes = new Uint8Array(length);
    let offset = 0;
    for (const chunk of chunks) {
      bytes.set(chunk, offset);
      offset += chunk.byteLength;
    }
    return new Response(bytes, {
      headers: {
        "content-type": "image/png",
        "cache-control": "private, no-store",
        "cross-origin-resource-policy": "same-origin",
        "x-content-type-options": "nosniff",
      },
    });
  } catch {
    return Response.json({ error: { code: "LOCAL_CAPTURE_UNAVAILABLE" } }, { status: 503 });
  }
}

import Link from "next/link";

import { isModelView } from "../../lib/model-form";
import { fetchConnections, fetchModels, runtimeOrigin } from "../../lib/runtime-client";
import { isConnectionView } from "../../lib/sign-in";
import { ModelsWorkspace } from "./models-workspace";

export const dynamic = "force-dynamic";

export const metadata = { title: "Models — Zet Harness" };

export default async function ModelsPage({
  searchParams,
}: {
  readonly searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const [result, connections, params] = await Promise.all([
    fetchModels(),
    fetchConnections(),
    searchParams,
  ]);
  const connection = connections.ok
    ? (connections.data.connections.find(isConnectionView) ?? null)
    : null;
  const connect = params["connect"];
  const startWith = connect === "signin" || connect === "key" ? connect : null;

  return (
    <main className="page">
      <nav className="crumbs">
        <Link href="/">Overview</Link>
        <span aria-hidden="true">/</span>
        <span>Models</span>
      </nav>

      <div className="pageHeader">
        <h1 className="pageTitle">Models</h1>
      </div>

      <p className="lede">
        Connect the models your agent steps call: sign in with OpenRouter, paste an API key for
        OpenAI, Anthropic, Google Gemini or xAI, or use a server running on this machine. Anything
        that speaks the OpenAI Chat Completions format works.
      </p>

      {!result.ok ? (
        <div className="panel">
          <p>{result.reason}</p>
          <p className="muted">
            Expected at <code>{runtimeOrigin()}</code>.
          </p>
        </div>
      ) : (
        <ModelsWorkspace
          initialModels={result.data.models.filter(isModelView)}
          initialConnection={connection}
          startWith={startWith}
        />
      )}
    </main>
  );
}

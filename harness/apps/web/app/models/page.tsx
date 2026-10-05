import Link from "next/link";

import { isModelView } from "../../lib/model-form";
import { fetchModels, runtimeOrigin } from "../../lib/runtime-client";
import { ModelsWorkspace } from "./models-workspace";

export const dynamic = "force-dynamic";

export const metadata = { title: "Models — Zet Harness" };

export default async function ModelsPage({
  searchParams,
}: {
  readonly searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const [result, params] = await Promise.all([fetchModels(), searchParams]);
  const startWith = params["connect"] === "key" ? "key" : null;

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
        Connect OpenAI, Claude or Grok with a provider API key, or use a local model. For Codex
        subscription access and its native coding agent, run the official CLI bridge:
        <code>npm run codex -- help</code>. Codex owns its login, tools, approvals and sessions.
        Claude and Grok subscription OAuth are unavailable here; use API credentials from their
        consoles.
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
          startWith={startWith}
        />
      )}
    </main>
  );
}

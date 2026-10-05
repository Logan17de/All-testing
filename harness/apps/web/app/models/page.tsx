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
        Models supply inference to the harness’s own agent loop, tools and sessions. Use an OpenAI
        API key or a local model, then open <Link href="/agent">Coding workspace</Link>. Claude/xAI
        billed integration remains inactive pending your decision. Provider subscription sign-in has
        separate registration and approval requirements.
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

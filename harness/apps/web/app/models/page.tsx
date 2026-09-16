import Link from "next/link";

import { isModelView } from "../../lib/model-form";
import { fetchModels, runtimeOrigin } from "../../lib/runtime-client";
import { ModelsWorkspace } from "./models-workspace";

export const dynamic = "force-dynamic";

export const metadata = { title: "Models — Zet Harness" };

export default async function ModelsPage() {
  const result = await fetchModels();

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
        Connect the models your agent steps call: a hosted API with its key, or a server running on
        this machine. Anything that speaks the OpenAI Chat Completions format works.
      </p>

      {!result.ok ? (
        <div className="panel">
          <p>{result.reason}</p>
          <p className="muted">
            Expected at <code>{runtimeOrigin()}</code>.
          </p>
        </div>
      ) : (
        <ModelsWorkspace initialModels={result.data.models.filter(isModelView)} />
      )}
    </main>
  );
}

import Link from "next/link";

import { isModelView } from "../../lib/model-form";
import { fetchModels, runtimeOrigin } from "../../lib/runtime-client";
import { ModelsWorkspace } from "./models-workspace";
import { ChatGPTConnection } from "../agent/chatgpt-connection";

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
      <nav className="crumbs" aria-label="Breadcrumb">
        <Link href="/">Overview</Link>
        <span aria-hidden="true">/</span>
        <span>Models</span>
      </nav>

      <div className="pageHeader">
        <h1 className="pageTitle">Models</h1>
      </div>

      <p className="lede">
        Connect your ChatGPT account, add an API model, or use a local model. Then open the{" "}
        <Link href="/agent">Coding workspace</Link> to choose a model and start a task.
      </p>

      <ChatGPTConnection />

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

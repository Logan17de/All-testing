import Link from "next/link";

import { fetchSetup, runtimeOrigin } from "../../lib/runtime-client";
import { SetupWizard } from "./setup-wizard";

export const dynamic = "force-dynamic";

export const metadata = { title: "Setup — Zet Harness" };

export default async function SetupPage() {
  const result = await fetchSetup();

  return (
    <main className="page">
      <nav className="crumbs">
        <Link href="/">Overview</Link>
        <span aria-hidden="true">/</span>
        <span>Setup</span>
      </nav>

      <div className="pageHeader">
        <h1 className="pageTitle">Set up the harness</h1>
      </div>

      {result.ok ? (
        <SetupWizard initial={result.data.setup} />
      ) : (
        <div className="panel">
          <p>{result.reason}</p>
          <p className="muted">
            Expected at <code>{runtimeOrigin()}</code>. Start the harness with{" "}
            <code>npm start</code>.
          </p>
        </div>
      )}
    </main>
  );
}

import Link from "next/link";

import { fetchRecentRuns, runtimeOrigin } from "../../lib/runtime-client";

export const dynamic = "force-dynamic";

export const metadata = { title: "Runs — Zet Harness" };

export default async function RunsPage() {
  const result = await fetchRecentRuns();

  return (
    <main className="page">
      <nav className="crumbs">
        <Link href="/">Overview</Link>
        <span aria-hidden="true">/</span>
        <span>Runs</span>
      </nav>

      <div className="pageHeader">
        <h1 className="pageTitle">Runs</h1>
        <Link className="btn btn--primary" href="/editor">
          Open editor
        </Link>
      </div>

      {!result.ok ? (
        <div className="panel">
          <p>{result.reason}</p>
          <p className="muted">
            Expected at <code>{runtimeOrigin()}</code>.
          </p>
        </div>
      ) : result.data.runs.length === 0 ? (
        <div className="panel">
          <p>No runs yet.</p>
          <p className="muted">
            Build a graph in the <Link href="/editor">editor</Link> and run it.
          </p>
        </div>
      ) : (
        <div className="tableWrap">
          <table className="runTable">
            <thead>
              <tr>
                <th scope="col">Run</th>
                <th scope="col">Graph</th>
                <th scope="col">Status</th>
                <th scope="col">Created</th>
              </tr>
            </thead>
            <tbody>
              {result.data.runs.map((run) => (
                <tr key={run.runId}>
                  <td>
                    <Link href={`/runs/${encodeURIComponent(run.runId)}`}>
                      <code>{run.runId.slice(0, 16)}</code>
                    </Link>
                  </td>
                  <td>{run.graphId}</td>
                  <td>
                    <span className={`runStatus runStatus--${run.status}`}>{run.status}</span>
                  </td>
                  <td>{new Date(run.createdAtMs).toLocaleString()}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </main>
  );
}

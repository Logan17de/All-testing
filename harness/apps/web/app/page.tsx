import Link from "next/link";
import { redirect } from "next/navigation";

import { HARNESS_PRODUCT_NAME } from "@zet-harness/shared";

import {
  fetchPluginReport,
  fetchRuntimeHealth,
  fetchSetup,
  fetchWorkspaces,
  runtimeOrigin,
} from "../lib/runtime-client";
import { isWorkspaceEntry } from "../lib/workspaces";
import { WorkspaceList } from "./workspace-list";

export const dynamic = "force-dynamic";

export default async function HomePage() {
  const [health, plugins, setup, listed] = await Promise.all([
    fetchRuntimeHealth(),
    fetchPluginReport(),
    fetchSetup(),
    fetchWorkspaces(),
  ]);
  // The first thing a new harness needs is to know where to work.
  if (setup.ok && !setup.data.setup.complete) redirect("/setup");
  const workspaces = listed.ok ? listed.data.workspaces.filter(isWorkspaceEntry) : [];

  const running = health.ok && health.data.status === "ok";
  const installedCount = plugins.ok ? plugins.data.installed.length : 0;
  const enabledCount = plugins.ok ? plugins.data.activated.length : 0;

  return (
    <main className="page">
      <p className="eyebrow">{HARNESS_PRODUCT_NAME.toUpperCase()}</p>
      <h1 className="pageTitle">A harness you can extend.</h1>
      <p className="lede">
        A provider-neutral, local-first runtime for models, tools, goals, memory, and agent
        workflows. Everything it can do beyond its core is a plugin, and anyone can write one.
      </p>

      <div className="status" role="status">
        <span className={`statusDot statusDot--${running ? "on" : "off"}`} aria-hidden="true" />
        {running ? "Runtime daemon is healthy" : "Runtime daemon is not reachable"}
      </div>

      <div className="btnRow pageActions">
        <Link className="btn btn--primary" href="/projects#new-project">
          New project
        </Link>
        <Link className="btn" href="/models">
          Models
        </Link>
        <Link className="btn" href="/plugins">
          Plugins
        </Link>
      </div>

      <WorkspaceList initial={workspaces} />

      <nav className="navLinks" aria-label="Sections">
        <Link href="/projects">Projects</Link>
        <Link href="/editor">Graph editor</Link>
        <Link href="/runs">Runs</Link>
        <Link href="/setup">Setup</Link>
      </nav>

      {running ? (
        <div className="stats">
          <Link className="stat" href="/plugins">
            <span className="statValue">{installedCount}</span>
            <span className="statLabel">
              installed {installedCount === 1 ? "plugin" : "plugins"}
            </span>
          </Link>
          <Link className="stat" href="/plugins">
            <span className="statValue">{enabledCount}</span>
            <span className="statLabel">enabled and active</span>
          </Link>
        </div>
      ) : (
        <div className="panel">
          <p className="muted">
            Start it with <code>npm run start --workspace @zet-harness/runtime</code>. It is
            expected at <code>{runtimeOrigin()}</code>; set <code>HARNESS_RUNTIME_URL</code> to
            point elsewhere.
          </p>
        </div>
      )}
    </main>
  );
}

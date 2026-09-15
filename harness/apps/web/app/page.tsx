import Link from "next/link";

import { HARNESS_PRODUCT_NAME } from "@zet-harness/shared";

import { fetchPluginReport, fetchRuntimeHealth, runtimeOrigin } from "../lib/runtime-client";

export const dynamic = "force-dynamic";

export default async function HomePage() {
  const [health, plugins] = await Promise.all([fetchRuntimeHealth(), fetchPluginReport()]);

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

      <nav className="navLinks" aria-label="Sections">
        <Link href="/editor">Graph editor</Link>
        <Link href="/projects">Projects</Link>
        <Link href="/runs">Runs</Link>
        <Link href="/plugins">Plugins</Link>
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

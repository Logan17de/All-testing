import Link from "next/link";

import { fetchPluginReport, runtimeOrigin, type PluginView } from "../../lib/runtime-client";

export const dynamic = "force-dynamic";

export const metadata = {
  title: "Plugins — Zet Harness",
};

function CapabilityList({
  label,
  capabilities,
  tone,
}: {
  readonly label: string;
  readonly capabilities: readonly string[];
  readonly tone: "granted" | "withheld";
}) {
  if (capabilities.length === 0) return null;
  return (
    <div className="capGroup">
      <span className="capLabel">{label}</span>
      <ul className="capList">
        {capabilities.map((capability) => (
          <li key={capability} className={`cap cap--${tone}`}>
            {capability}
          </li>
        ))}
      </ul>
    </div>
  );
}

function PluginCard({ plugin }: { readonly plugin: PluginView }) {
  return (
    <article className="card">
      <header className="cardHead">
        <div>
          <h2 className="cardTitle">{plugin.name}</h2>
          <p className="cardMeta">
            {plugin.id} · v{plugin.version} · {plugin.license}
          </p>
        </div>
        <span className={`badge badge--${plugin.enabled ? "on" : "off"}`}>
          {plugin.enabled ? "Enabled" : "Disabled"}
        </span>
      </header>

      {plugin.declaredNodes.length > 0 ? (
        <p className="cardNodes">
          Provides{" "}
          {plugin.declaredNodes.map((node) => (
            <code key={node}>{node}</code>
          ))}
        </p>
      ) : (
        <p className="cardNodes muted">Registers no nodes.</p>
      )}

      {plugin.requestedCapabilities.length === 0 ? (
        <p className="muted">Requests no capabilities.</p>
      ) : (
        <div className="caps">
          <CapabilityList
            label="Granted"
            capabilities={plugin.grantedCapabilities}
            tone="granted"
          />
          <CapabilityList
            label="Withheld"
            capabilities={plugin.withheldCapabilities}
            tone="withheld"
          />
        </div>
      )}

      {plugin.unsigned ? (
        <p className="warn">
          Unsigned — this package ships no integrity digests, so its files cannot be verified.
        </p>
      ) : null}
    </article>
  );
}

export default async function PluginsPage() {
  const report = await fetchPluginReport();

  return (
    <main className="page">
      <nav className="crumbs">
        <Link href="/">Overview</Link>
        <span aria-hidden="true">/</span>
        <span>Plugins</span>
      </nav>

      <h1 className="pageTitle">Plugins</h1>

      {!report.ok ? (
        <div className="panel">
          <p>{report.reason}</p>
          <p className="muted">
            Expected at <code>{runtimeOrigin()}</code>. Start the runtime with{" "}
            <code>npm run start --workspace @zet-harness/runtime</code>, or set{" "}
            <code>HARNESS_RUNTIME_URL</code> if it listens elsewhere.
          </p>
        </div>
      ) : (
        <>
          <p className="lede">
            Installed packages are read from <code>{report.data.directory}</code>. A plugin stays
            disabled until it is enabled in <code>plugins.json</code>, and a capability it requests
            is granted there too — installing a plugin never authorizes it.
          </p>

          {report.data.configDefects.length > 0 ? (
            <div className="panel panel--warn">
              <h2 className="panelTitle">Configuration problems</h2>
              <ul>
                {report.data.configDefects.map((defect) => (
                  <li key={defect}>{defect}</li>
                ))}
              </ul>
            </div>
          ) : null}

          {report.data.failures.length > 0 ? (
            <div className="panel panel--warn">
              <h2 className="panelTitle">Packages that did not load</h2>
              <ul>
                {report.data.failures.map((failure) => (
                  <li key={`${failure.packageName}:${failure.code}`}>
                    <strong>{failure.packageName}</strong> — {failure.message}{" "}
                    <code>{failure.code}</code>
                  </li>
                ))}
              </ul>
            </div>
          ) : null}

          {report.data.installed.length === 0 ? (
            <div className="panel">
              <p>No plugins are installed yet.</p>
              <p className="muted">
                Copy a package directory into <code>{report.data.directory}</code>. Each package
                needs a <code>zet-plugin.json</code> and an entry module;{" "}
                <code>examples/hello-plugin</code> is a complete one to start from.
              </p>
            </div>
          ) : (
            <div className="cards">
              {report.data.installed.map((plugin) => (
                <PluginCard key={plugin.id} plugin={plugin} />
              ))}
            </div>
          )}
        </>
      )}
    </main>
  );
}

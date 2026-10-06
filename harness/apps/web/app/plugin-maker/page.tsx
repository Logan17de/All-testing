import Link from "next/link";
import { PluginMakerWorkspace } from "./plugin-maker-workspace";

export const metadata = { title: "Plugin maker — Zet Harness" };

export default function PluginMakerPage() {
  return (
    <main className="page">
      <nav className="crumbs">
        <Link href="/overview">Overview</Link>
        <span>/</span>
        <span>Plugin maker</span>
        <Link href="/agent">Coding chats</Link>
        <Link href="/plugins">Installed plugins</Link>
      </nav>
      <h1 className="pageTitle">Plugin maker</h1>
      <p className="lede">
        Build a local harness plugin, check its code and requested permissions, then review it
        before enabling it. Creating or testing a draft does not authorize the plugin.
      </p>
      <PluginMakerWorkspace />
      <section className="panel">
        <h2 className="panelTitle">Marketplace</h2>
        <p className="muted">
          A future ZetbrosSite marketplace is planned. Publishing, website connections and
          deployment are not available here.
        </p>
      </section>
    </main>
  );
}

import Link from "next/link";
import { CodexWorkspace } from "./codex-workspace";

export const metadata = { title: "Codex — Zet Harness" };

export default function CodexPage() {
  return (
    <main className="page">
      <nav className="crumbs">
        <Link href="/">Overview</Link>
        <span>/</span>
        <span>Codex</span>
        <Link href="/models">Models</Link>
      </nav>
      <h1 className="pageTitle">Native Codex workspace</h1>
      <p className="lede">
        The official Codex CLI owns coding tools, sandbox enforcement, instructions, MCP
        configuration and saved sessions. This workspace displays its live events and approval
        requests.
      </p>
      <CodexWorkspace />
    </main>
  );
}

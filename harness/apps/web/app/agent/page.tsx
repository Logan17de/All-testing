import Link from "next/link";
import { ChatGPTConnection } from "./chatgpt-connection";
import { AgentWorkspace } from "./agent-workspace";

export const metadata = { title: "Coding workspace — Zet Harness" };

export default function AgentPage() {
  return (
    <main className="page">
      <nav className="crumbs">
        <Link href="/">Overview</Link>
        <span>/</span>
        <span>Coding workspace</span>
        <Link href="/models">Models</Link>
      </nav>
      <h1 className="pageTitle">Coding workspace</h1>
      <p className="lede">
        Run coding tasks with your configured provider models. The harness owns the agent loop,
        workspace tools, approvals and saved sessions.
      </p>
      <ChatGPTConnection />
      <AgentWorkspace />
    </main>
  );
}

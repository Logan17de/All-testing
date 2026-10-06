import Link from "next/link";
import { ChatGPTConnection } from "./chatgpt-connection";
import { AgentWorkspace } from "./agent-workspace";

export const metadata = { title: "Coding workspace — Zet Harness" };

export default async function AgentPage({
  searchParams,
}: {
  searchParams: Promise<{ session?: string }>;
}) {
  const query = await searchParams;
  return (
    <main className="page">
      <nav className="crumbs">
        <Link href="/overview">Overview</Link>
        <span>/</span>
        <span>Coding workspace</span>
        <Link href="/assistant">Personal assistant</Link>
        <Link href="/plugin-maker">Plugin maker</Link>
        <Link href="/models">Models</Link>
      </nav>
      <h1 className="pageTitle">Coding workspace</h1>
      <p className="lede">
        Run coding tasks with your configured provider models. The harness owns the agent loop,
        workspace tools, approvals and saved sessions.
      </p>
      <details className="panel">
        <summary>Account connection setup</summary>
        <ChatGPTConnection />
      </details>
      <AgentWorkspace initialSessionId={typeof query.session === "string" ? query.session : ""} />
    </main>
  );
}

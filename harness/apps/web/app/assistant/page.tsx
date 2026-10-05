import Link from "next/link";
import { AssistantWorkspace } from "./assistant-workspace";
export const metadata = { title: "Personal assistant — Zet Harness" };
export default async function AssistantPage({
  searchParams,
}: {
  searchParams: Promise<{ assistant?: string }>;
}) {
  const query = await searchParams;
  return (
    <main className="page">
      <nav className="crumbs">
        <Link href="/overview">Overview</Link>
        <span>/</span>
        <span>Personal assistant</span>
        <Link href="/agent">Coding chats</Link>
      </nav>
      <h1 className="pageTitle">Personal assistant</h1>
      <p className="lede">
        Manage the chats your assistant may read or control. Each connection is an explicit
        authorization; disconnected chats stay inaccessible.
      </p>
      <AssistantWorkspace
        initialAssistantId={typeof query.assistant === "string" ? query.assistant : ""}
      />
    </main>
  );
}

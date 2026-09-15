import Link from "next/link";

import { ConversationChat } from "./conversation-chat";

export const metadata = { title: "Conversation — Zet Harness" };

export default async function ConversationPage({
  params,
}: {
  readonly params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  return (
    <main className="page">
      <nav className="crumbs">
        <Link href="/">Overview</Link>
        <span aria-hidden="true">/</span>
        <Link href="/projects">Projects</Link>
        <span aria-hidden="true">/</span>
        <code>{id.slice(0, 8)}</code>
      </nav>
      <ConversationChat conversationId={id} />
    </main>
  );
}

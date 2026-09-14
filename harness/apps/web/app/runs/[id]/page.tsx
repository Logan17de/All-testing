import Link from "next/link";

import { RunInspectorLoader } from "./run-inspector-loader";

export const metadata = { title: "Run — Zet Harness" };

export default async function RunPage({ params }: { readonly params: Promise<{ id: string }> }) {
  const { id } = await params;
  return (
    <main className="editorPage">
      <nav className="crumbs">
        <Link href="/">Overview</Link>
        <span aria-hidden="true">/</span>
        <Link href="/runs">Runs</Link>
        <span aria-hidden="true">/</span>
        <code>{id.slice(0, 16)}</code>
      </nav>
      <RunInspectorLoader runId={id} />
    </main>
  );
}

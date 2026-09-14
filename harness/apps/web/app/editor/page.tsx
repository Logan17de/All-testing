import Link from "next/link";

import { EditorLoader } from "./editor-loader";

export const metadata = { title: "Editor — Zet Harness" };

export default function EditorPage() {
  return (
    <main className="editorPage">
      <nav className="crumbs">
        <Link href="/">Overview</Link>
        <span aria-hidden="true">/</span>
        <span>Graph editor</span>
        <span aria-hidden="true">·</span>
        <Link href="/runs">Runs</Link>
      </nav>
      <EditorLoader />
    </main>
  );
}

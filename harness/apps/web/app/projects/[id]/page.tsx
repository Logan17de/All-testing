import Link from "next/link";

import { ProjectWorkspace } from "./project-workspace";

export const metadata = { title: "Project — Zet Harness" };

export default async function ProjectPage({
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
      <ProjectWorkspace projectId={id} />
    </main>
  );
}

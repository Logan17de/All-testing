import Link from "next/link";
import { DesktopSession } from "../agent/desktop-session";

export const metadata = { title: "Desktop session — Zet Harness" };

export default async function DesktopPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const params = await searchParams;
  return (
    <main className="page">
      <nav className="crumbs">
        <Link href="/agent">Coding workspace</Link>
        <span>/</span>
        <span>Desktop session</span>
      </nav>
      <h1 className="pageTitle">Desktop session</h1>
      <DesktopSession initialTask={typeof params.task === "string" ? params.task : ""} />
    </main>
  );
}

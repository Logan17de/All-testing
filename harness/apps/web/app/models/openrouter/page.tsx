import Link from "next/link";

import { codeFromReturn } from "../../../lib/sign-in";
import { FinishSignIn } from "./finish-sign-in";

export const dynamic = "force-dynamic";

export const metadata = { title: "Signing in — Zet Harness" };

/** Where OpenRouter sends a person back after they approve this app. */
export default async function OpenRouterReturnPage({
  searchParams,
}: {
  readonly searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const params = await searchParams;
  const search = new URLSearchParams();
  for (const key of ["code", "error"]) {
    const value = params[key];
    if (typeof value === "string") search.set(key, value);
  }
  const returned = codeFromReturn(search);

  return (
    <main className="page">
      <nav className="crumbs">
        <Link href="/">Overview</Link>
        <span aria-hidden="true">/</span>
        <Link href="/models">Models</Link>
        <span aria-hidden="true">/</span>
        <span>OpenRouter sign-in</span>
      </nav>

      <div className="pageHeader">
        <h1 className="pageTitle">Signing in to OpenRouter</h1>
      </div>

      {"code" in returned ? (
        <FinishSignIn code={returned.code} />
      ) : (
        <div className="panel">
          <p>{returned.reason}</p>
          <div className="btnRow">
            <Link className="btn btn--primary" href="/models?connect=signin">
              Back to Models
            </Link>
          </div>
        </div>
      )}
    </main>
  );
}

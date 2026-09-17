"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useRef, useState } from "react";

import { workspaceRequest } from "../../../lib/workspace-client";

/**
 * Hand the code OpenRouter returned to the runtime, once, and go back to Models.
 *
 * The code is single-use, so a second attempt (a development double render, or a
 * reload) must not be made: the ref survives both.
 */
export function FinishSignIn({ code }: { readonly code: string }) {
  const router = useRouter();
  const sent = useRef(false);
  const [failure, setFailure] = useState<string | null>(null);

  useEffect(() => {
    if (sent.current) return;
    sent.current = true;
    // The code is spent either way; keep it out of the address bar and history.
    window.history.replaceState(null, "", "/models/openrouter");
    void workspaceRequest("connections/openrouter/complete", { code }).then((result) => {
      if (result.ok) {
        router.replace("/models?connect=signin");
        return;
      }
      setFailure(result.reason);
    });
  }, [code, router]);

  if (failure !== null) {
    return (
      <div className="panel">
        <p className="field__error" role="alert">
          {failure}
        </p>
        <div className="btnRow">
          <Link className="btn btn--primary" href="/models?connect=signin">
            Back to Models
          </Link>
        </div>
      </div>
    );
  }
  return (
    <div className="panel">
      <p role="status">Finishing the sign-in…</p>
    </div>
  );
}

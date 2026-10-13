"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { AgentWorkspace } from "../agent/agent-workspace";
import { SettingsPopup } from "./settings-popup";
import type { SettingsId } from "./settings-view";

export function SettingsRoute({ initialSection }: { initialSection: SettingsId }) {
  const router = useRouter();
  const [open, setOpen] = useState(true);
  return (
    <main className="codingPage">
      <AgentWorkspace />
      {open && (
        <SettingsPopup
          initialSection={initialSection}
          onClose={() => {
            setOpen(false);
            router.replace("/agent");
          }}
          onNavigate={() => setOpen(false)}
        />
      )}
    </main>
  );
}

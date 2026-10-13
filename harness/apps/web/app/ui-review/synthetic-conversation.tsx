"use client";

import type { MessageView } from "../../lib/workspace-types";
import type { MutationApproval } from "../agent/agent-view";
import { ChatMessages } from "../agent/chat-messages";
import { MutationApprovalCard } from "../agent/mutation-approval";

const base = {
  conversationId: "synthetic-conversation",
  model: "synthetic-model",
  runId: "synthetic-run",
  createdAtMs: 1791288000000,
};
const messages: MessageView[] = [
  {
    ...base,
    messageId: "synthetic-user",
    parentMessageId: null,
    role: "user",
    parts: [
      {
        kind: "text",
        text: "Review the settings screen and make the save status easier to understand on smaller screens.",
      },
    ],
  },
  {
    ...base,
    messageId: "synthetic-inspection",
    parentMessageId: "synthetic-user",
    role: "assistant",
    parts: [
      {
        kind: "text",
        text: "I found the settings form. The save status wraps beside the action buttons on narrow screens. I’ll propose a small layout change and check the existing tests.",
      },
      {
        kind: "tool-call",
        callId: "synthetic-read",
        name: "workspace.read_file",
        arguments: { path: "src/settings.tsx" },
      },
      {
        kind: "tool-result",
        callId: "synthetic-read",
        value: {
          path: "src/settings.tsx",
          lines: 84,
          summary: "Synthetic settings form with a save button and inline status.",
        },
      },
    ],
  },
  {
    ...base,
    messageId: "synthetic-followup",
    parentMessageId: "synthetic-inspection",
    role: "assistant",
    parts: [
      {
        kind: "text",
        text: "The proposed change places save feedback below the controls and preserves the current form behavior. This sample is waiting for review of the exact file action below.",
      },
      {
        kind: "tool-call",
        callId: "synthetic-tests",
        name: "process.run",
        arguments: { command: "test settings" },
      },
      {
        kind: "tool-result",
        callId: "synthetic-tests",
        value: {
          exitCode: 0,
          testsPassed: 6,
          output: "Synthetic output: all six settings checks passed.",
        },
      },
    ],
  },
];
const approval: MutationApproval = {
  id: "synthetic-approval",
  sessionId: "synthetic-session",
  runId: "synthetic-run",
  tool: "workspace.apply_patch",
  requestGeneration: 1,
  expiresAtMs: 1893456000000,
  args: {
    path: "src/settings.tsx",
    change: "Move save feedback below the action row; preserve form submission behavior.",
  },
};

export function SyntheticConversation() {
  return (
    <>
      <section className="panel" aria-label="Synthetic populated conversation">
        <h2 className="panelTitle">Populated conversation</h2>
        <ChatMessages transcript={{ messages }} />
      </section>
      <section className="panel" aria-label="Synthetic approval preview">
        <h2 className="panelTitle">Pending approval preview</h2>
        <p className="muted">
          The real approval component is shown below. Its controls are disabled for this synthetic
          preview.
        </p>
        <fieldset disabled style={{ border: 0, padding: 0, margin: 0, minWidth: 0 }}>
          <legend className="small muted">Synthetic request · disabled controls</legend>
          <MutationApprovalCard request={approval} respond={async () => {}} />
        </fieldset>
      </section>
    </>
  );
}

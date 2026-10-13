import { isSortableId } from "../../lib/ids";
export function ChatExportLink({
  sessionId,
  available,
  busy = false,
}: {
  sessionId: string;
  available: boolean;
  busy?: boolean;
}) {
  return available && !busy && isSortableId(sessionId) ? (
    <a
      href={`/api/editor/chat-export/${encodeURIComponent(sessionId)}`}
      download
      title="Download the current saved branch as readable Markdown"
    >
      Export Markdown
    </a>
  ) : (
    <button
      type="button"
      disabled
      title={
        available
          ? "Select a saved chat to export."
          : "Transcript export unavailable: runtime update required."
      }
    >
      Export Markdown
    </button>
  );
}

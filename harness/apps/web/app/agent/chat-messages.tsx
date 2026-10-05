import { latestBranch } from "../../lib/workspace-types";
import { chatMessages } from "./chat-message-view";
export function ChatMessages({ transcript }: { transcript: unknown }) {
  const messages = latestBranch(chatMessages(transcript));
  return (
    <div className="chatLog" aria-label="Chat messages">
      {messages.length ? (
        messages.map((message) => (
          <article
            key={message.messageId}
            className={`chatMessage chatMessage--${message.role === "user" ? "user" : "assistant"}`}
            aria-label={`${message.role} message`}
          >
            <strong>
              {message.role === "user"
                ? "You"
                : message.role === "assistant"
                  ? "Assistant"
                  : message.role}
            </strong>
            {message.parts.map((part, index) =>
              part.kind === "text" ? (
                <p key={index} className="chatText" style={{ whiteSpace: "pre-wrap" }}>
                  {part.text}
                </p>
              ) : (
                <details key={index}>
                  <summary>
                    {part.kind === "reasoning"
                      ? "Reasoning"
                      : part.kind === "tool-call"
                        ? `Tool: ${part.name}`
                        : part.kind === "tool-result"
                          ? "Tool result"
                          : "Image reference"}
                  </summary>
                  <pre style={{ whiteSpace: "pre-wrap", overflowWrap: "anywhere" }}>
                    {part.kind === "reasoning" ? part.text : JSON.stringify(part, null, 2)}
                  </pre>
                </details>
              ),
            )}
          </article>
        ))
      ) : (
        <p className="muted">
          Start a chat and send a task. Its graph appears here when connected; you can keep chatting
          with the graph collapsed.
        </p>
      )}
    </div>
  );
}

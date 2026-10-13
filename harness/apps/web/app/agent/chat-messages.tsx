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
            {message.role === "assistant" &&
            !message.parts.some((part) =>
              part.kind === "text" || part.kind === "reasoning" ? part.text.trim() : true,
            ) ? (
              <p className="chatText">No response text was returned.</p>
            ) : null}
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
        <div className="codingEmpty">
          <div className="codingEmptyMark" aria-hidden="true">
            Z
          </div>
          <h2>What are we building?</h2>
          <p>Explore your code. Work through an idea. Build something new.</p>
          <span>Choose a model. Start a chat. Make it yours.</span>
        </div>
      )}
    </div>
  );
}

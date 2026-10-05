import { type MessageView } from "../../lib/workspace-types";
export function chatMessages(value: unknown): MessageView[] {
  if (!value || typeof value !== "object") return [];
  const messages = (value as { messages?: unknown }).messages;
  if (!Array.isArray(messages)) return [];
  return messages.filter((raw: unknown): raw is MessageView => {
    if (!raw || typeof raw !== "object") return false;
    const message = raw as Record<string, unknown>;
    return (
      typeof message.messageId === "string" &&
      typeof message.role === "string" &&
      (message.parentMessageId === null || typeof message.parentMessageId === "string") &&
      Array.isArray(message.parts) &&
      message.parts.every((rawPart: unknown) => {
        if (!rawPart || typeof rawPart !== "object") return false;
        const part = rawPart as Record<string, unknown>;
        if (part.kind === "text" || part.kind === "reasoning") return typeof part.text === "string";
        if (part.kind === "tool-call")
          return (
            typeof part.name === "string" &&
            typeof part.callId === "string" &&
            Boolean(part.arguments && typeof part.arguments === "object")
          );
        if (part.kind === "tool-result") return typeof part.callId === "string";
        return (
          part.kind === "image" &&
          typeof part.artifactRef === "string" &&
          typeof part.mediaType === "string"
        );
      })
    );
  });
}

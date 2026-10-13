export type SessionTranscript = { sessionId: string; value: unknown };

// A late read may finish after navigation. Never display it in another chat.
export function sessionTranscript(loaded: SessionTranscript | null, sessionId: string): unknown {
  return sessionId && loaded?.sessionId === sessionId ? loaded.value : null;
}

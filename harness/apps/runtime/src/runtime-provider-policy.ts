/** Separately billed Claude/xAI API substitution awaits the user's decision. */
export function providerAwaitingDecision(model: { profile?: unknown; baseUrl?: unknown }): boolean {
  if (model.profile === "anthropic" || model.profile === "xai") return true;
  if (typeof model.baseUrl !== "string") return false;
  try {
    const host = new URL(model.baseUrl).hostname.toLowerCase();
    return ["anthropic.com", "x.ai"].some(
      (domain) => host === domain || host.endsWith(`.${domain}`),
    );
  } catch {
    return false;
  }
}

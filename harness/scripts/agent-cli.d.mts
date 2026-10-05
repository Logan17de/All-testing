export function parseAgentCommand(argv: readonly string[]): {
  command: string;
  origin: string;
  body?: { action: string; params: Record<string, string | boolean | string[]> };
};
export function runAgentCommand(argv: readonly string[], request?: typeof fetch): Promise<string>;

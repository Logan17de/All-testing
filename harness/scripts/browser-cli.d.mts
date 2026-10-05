export function parseBrowserCommand(argv: string[]): {
  command: string;
  origin: string;
  body?: { action: string; params: Record<string, unknown> };
};
export function runBrowserCommand(argv: string[], request?: typeof fetch): Promise<string>;

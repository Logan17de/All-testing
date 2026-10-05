export const HELP: string;
export function bridgeArgs(argv: readonly string[], cwd?: string): string[] | null;
export function runBridge(argv: readonly string[]): Promise<number>;

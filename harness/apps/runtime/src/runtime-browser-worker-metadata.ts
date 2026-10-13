import { stat } from "node:fs/promises";
export interface BrowserExecutableMetadata {
  executablePresent: boolean;
  expectedRevision: boolean;
}
/** Only fixed worker-owned SDK resolver output; never an HTTP/model path. */
export async function browserExecutableMetadata(
  executable: string,
): Promise<BrowserExecutableMetadata> {
  let executablePresent = true;
  try {
    executablePresent = (await stat(executable)).isFile();
  } catch {
    executablePresent = false;
  }
  return {
    executablePresent,
    expectedRevision: /(?:^|[\\/])chromium-1243[\\/]chrome-win64[\\/]chrome\.exe$/u.test(
      executable,
    ),
  };
}

// Native browser acceptance: an isolated Windows worker must create a Chromium
// context and page. No navigation, user data, network requests or credentials.
import { chromium } from "playwright-core";
import { browserExecutableMetadata } from "../apps/runtime/dist/runtime-browser-worker-metadata.js";
import { createIsolatedBrowserDriver } from "../apps/runtime/dist/runtime-browser-isolated-driver.js";

if (process.platform !== "win32") {
  throw new Error("Windows browser smoke must run on Windows.");
}

const environment = await browserExecutableMetadata(chromium.executablePath());
if (!environment.executablePresent || !environment.expectedRevision) {
  throw new Error("Pinned Playwright Chromium not installed as expected.");
}

const abort = new AbortController();
let driver;
let diagnostic = "none";
try {
  driver = await createIsolatedBrowserDriver({
    signal: abort.signal,
    // Deliberately never permit navigation. The page has no external content.
    scope: { permits: () => false },
    pins: [{ hostname: "example.com", address: "93.184.215.14", family: 4 }],
    onFailure: (_phase, code) => {
      diagnostic = code ?? "worker-exit";
    },
  });
  console.log("WINDOWS_BROWSER_PAGE_READY isolated=true network=false");
} catch {
  console.error(`WINDOWS_BROWSER_PAGE_FAILED diagnostic=${diagnostic}`);
  process.exitCode = 1;
} finally {
  abort.abort();
  await driver?.close();
}

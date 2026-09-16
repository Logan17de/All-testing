/** The `setup` command line. The work itself lives in setup-cli.ts. */
import { resolve } from "node:path";

import { main } from "./setup-cli.js";

// The harness root is two levels above apps/runtime/dist, where npm runs this from.
process.exitCode = await main(process.argv.slice(2), resolve(process.cwd()));

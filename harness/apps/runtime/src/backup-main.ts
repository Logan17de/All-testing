/** The `backup` and `restore` command line. The work itself lives in backup-cli.ts. */
import { main } from "./backup-cli.js";

process.exitCode = await main(process.argv.slice(2));

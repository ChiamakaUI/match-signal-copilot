/**
 * match-signal-copilot production entrypoint (composition root).
 *
 * Wires the REAL modules together — {@link loadConfig} reads `process.env`,
 * {@link createLogger} builds the structured stdout logger at the configured
 * level, and {@link startServer} binds the health-check endpoint to
 * `config.port`. This is the terminal scaffold slice: a reachable `/health`
 * proves the service boots. Later slices add the live match/odds ingestion
 * pipeline on top of this same wiring.
 */

import { fileURLToPath } from "node:url";

import { loadConfig } from "./config.js";
import { createLogger } from "./logger.js";
import { startServer, type RunningServer } from "./server.js";

/**
 * Build the production dependencies from the environment and start the HTTP
 * service. Returns the running-server handle so callers (and the e2e test) can
 * observe the bound port and shut it down cleanly.
 */
export async function main(): Promise<RunningServer> {
  const config = loadConfig();
  const logger = createLogger({ level: config.logLevel });
  return startServer({ config, logger });
}

// Auto-start only when executed directly (`node dist/index.js` / `tsx src/index.ts`),
// never when imported by a test or another module.
const entryArg = process.argv[1];
const isEntrypoint =
  entryArg !== undefined && fileURLToPath(import.meta.url) === entryArg;

if (isEntrypoint) {
  main().catch((err: unknown) => {
    // Startup failure (e.g. port in use) must fail loud, not exit silently.
    process.stderr.write(
      `fatal: failed to start match-signal-copilot: ${String(err)}\n`,
    );
    process.exitCode = 1;
  });
}

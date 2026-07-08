/**
 * match-signal-copilot entrypoint.
 *
 * For now this only logs a startup line. The health-check server and the
 * live match/odds signal ingestion pipeline land in later slices; the
 * config + structured logging modules that follow this scaffold will
 * replace the bare `console.log` below.
 */

export const STARTUP_MESSAGE =
  "match-signal-copilot: service starting" as const;

export function main(): void {
  // eslint-disable-next-line no-console -- structured logging arrives in a later slice
  console.log(STARTUP_MESSAGE);
}

main();

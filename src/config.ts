/**
 * Environment-based, typed configuration for match-signal-copilot.
 *
 * Every later module reads its settings from the {@link AppConfig} produced by
 * {@link loadConfig} rather than touching `process.env` ad hoc. The loader is
 * FAIL-FAST: a required variable that is present but invalid (a non-numeric or
 * out-of-range `PORT`, an unrecognized `LOG_LEVEL`) throws at load time instead
 * of silently coercing to a bad default (`Number("abc")` → `NaN`).
 */

/** Severity ordering, lowest-to-highest. Shared with {@link ./logger.ts}. */
export const LOG_LEVELS = ["debug", "info", "warn", "error"] as const;

/** A recognized structured-log severity. */
export type LogLevel = (typeof LOG_LEVELS)[number];

/** The fully-resolved, validated service configuration. */
export interface AppConfig {
  /** Deployment environment, e.g. `"development"` or `"production"`. */
  nodeEnv: string;
  /** TCP port the HTTP entrypoint binds to. */
  port: number;
  /** Minimum severity the structured logger emits. */
  logLevel: LogLevel;
}

/** Defaults applied when a variable is absent from the environment. */
const DEFAULT_NODE_ENV = "development";
const DEFAULT_PORT = 3000;
const DEFAULT_LOG_LEVEL: LogLevel = "info";

/** Inclusive TCP port range. Port 0 (ephemeral) is rejected as a service bind. */
const MIN_PORT = 1;
const MAX_PORT = 65535;

function isLogLevel(value: string): value is LogLevel {
  return (LOG_LEVELS as readonly string[]).includes(value);
}

/**
 * Parse and validate a `PORT` string into an integer in `[1, 65535]`.
 *
 * Throws a descriptive error for anything non-numeric, fractional, or out of
 * range — never returns `NaN` or a coerced fallback.
 */
function parsePort(raw: string): number {
  const trimmed = raw.trim();
  // Reject empty / whitespace and any non-digit content up front so
  // `Number` cannot silently accept `"0x10"`, `"1e3"`, or `" 80 "`-style input.
  if (!/^\d+$/.test(trimmed)) {
    throw new Error(`Invalid PORT: expected a positive integer, got "${raw}"`);
  }
  const port = Number(trimmed);
  if (!Number.isInteger(port) || port < MIN_PORT || port > MAX_PORT) {
    throw new Error(
      `Invalid PORT: expected an integer in [${MIN_PORT}, ${MAX_PORT}], got "${raw}"`,
    );
  }
  return port;
}

/**
 * Load configuration from the given environment (defaults to `process.env`).
 *
 * Accepting the env as a parameter keeps the loader pure and testable — the
 * production composition root calls `loadConfig()` with the real `process.env`.
 */
export function loadConfig(env: NodeJS.ProcessEnv = process.env): AppConfig {
  const nodeEnv = env.NODE_ENV ?? DEFAULT_NODE_ENV;

  const port = env.PORT === undefined ? DEFAULT_PORT : parsePort(env.PORT);

  let logLevel: LogLevel;
  if (env.LOG_LEVEL === undefined) {
    logLevel = DEFAULT_LOG_LEVEL;
  } else if (isLogLevel(env.LOG_LEVEL)) {
    logLevel = env.LOG_LEVEL;
  } else {
    throw new Error(
      `Invalid LOG_LEVEL: expected one of ${LOG_LEVELS.join(", ")}, got "${env.LOG_LEVEL}"`,
    );
  }

  return { nodeEnv, port, logLevel };
}

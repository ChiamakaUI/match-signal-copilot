/**
 * Structured (one-JSON-object-per-line) logger for match-signal-copilot.
 *
 * Every line carries at least `level`, `msg`, and `time`; callers may attach
 * arbitrary structured fields. Lines below the configured {@link LogLevel} are
 * suppressed. This replaces ad-hoc `console.log` across the service so output
 * is machine-parseable from day one.
 */

import { LOG_LEVELS, type LogLevel } from "./config.ts";

/** Numeric severity per level, used for the emit threshold comparison. */
const SEVERITY: Record<LogLevel, number> = {
  debug: 10,
  info: 20,
  warn: 30,
  error: 40,
};

/** Extra structured fields merged into a log line. */
export type LogFields = Record<string, unknown>;

/** A configured structured logger. */
export interface Logger {
  debug(msg: string, fields?: LogFields): void;
  info(msg: string, fields?: LogFields): void;
  warn(msg: string, fields?: LogFields): void;
  error(msg: string, fields?: LogFields): void;
  /** Emit at an explicit level (used by the level-specific helpers above). */
  log(level: LogLevel, msg: string, fields?: LogFields): void;
}

/** Options for {@link createLogger}. */
export interface LoggerOptions {
  /** Minimum severity to emit; lower-severity lines are dropped. */
  level: LogLevel;
  /**
   * Sink for a finished line (already newline-terminated). Defaults to the
   * production stdout writer; overridable in tests.
   */
  write?: (line: string) => void;
  /** Clock, injectable for deterministic tests. Defaults to the wall clock. */
  now?: () => Date;
}

function defaultWrite(line: string): void {
  process.stdout.write(line);
}

/**
 * Build a {@link Logger} that emits JSON lines to the configured sink,
 * honoring `options.level` as the minimum severity.
 */
export function createLogger(options: LoggerOptions): Logger {
  const threshold = SEVERITY[options.level];
  const write = options.write ?? defaultWrite;
  const now = options.now ?? (() => new Date());

  function log(level: LogLevel, msg: string, fields?: LogFields): void {
    if (SEVERITY[level] < threshold) return;
    // Spread caller fields FIRST so the core fields below always win — a
    // caller cannot clobber `level`/`msg`/`time` with a colliding key.
    const record = { ...(fields ?? {}), level, time: now().toISOString(), msg };
    write(`${JSON.stringify(record)}\n`);
  }

  const helpers = {} as Logger;
  for (const level of LOG_LEVELS) {
    helpers[level] = (msg: string, fields?: LogFields): void =>
      log(level, msg, fields);
  }
  helpers.log = log;
  return helpers;
}

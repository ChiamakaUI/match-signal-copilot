import { test } from "node:test";
import assert from "node:assert/strict";

import { createLogger } from "../src/logger.ts";

/**
 * Capture the REAL production default sink (process.stdout.write) so these
 * tests exercise the composition root, not an injected fake.
 */
function captureStdout(fn: () => void): string[] {
  const original = process.stdout.write.bind(process.stdout);
  const chunks: string[] = [];
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  process.stdout.write = ((chunk: any): boolean => {
    chunks.push(String(chunk));
    return true;
  }) as typeof process.stdout.write;
  try {
    fn();
  } finally {
    process.stdout.write = original;
  }
  return chunks
    .join("")
    .split("\n")
    .filter((l) => l.length > 0);
}

test("logger_json: emits a single-line JSON object with level, msg, time", () => {
  const lines = captureStdout(() => {
    const log = createLogger({ level: "info" });
    log.info("service up");
  });

  assert.equal(
    lines.length,
    1,
    `expected exactly one line, got ${lines.length}`,
  );
  const parsed = JSON.parse(lines[0] as string) as Record<string, unknown>;
  assert.equal(
    parsed.level,
    "info",
    `level must equal the log level used, got ${String(parsed.level)}`,
  );
  assert.equal(parsed.msg, "service up", "msg must be the logged message");
  assert.equal(
    typeof parsed.time,
    "string",
    "time must be present as a string",
  );
  // time must be a real, parseable timestamp — not an empty placeholder.
  assert.ok(
    !Number.isNaN(Date.parse(parsed.time as string)),
    "time must be a parseable timestamp",
  );
});

test("logger_level: debug is suppressed at LOG_LEVEL=info but emitted at LOG_LEVEL=debug", () => {
  // Suppressed: a debug call at info level produces NO output.
  const suppressed = captureStdout(() => {
    const log = createLogger({ level: "info" });
    log.debug("noisy detail");
  });
  assert.equal(
    suppressed.length,
    0,
    `debug must be suppressed at info level, got ${suppressed.length} lines`,
  );

  // Emitted: the same debug call at debug level produces output.
  const emitted = captureStdout(() => {
    const log = createLogger({ level: "debug" });
    log.debug("noisy detail");
  });
  assert.equal(
    emitted.length,
    1,
    `debug must be emitted at debug level, got ${emitted.length} lines`,
  );
  const parsed = JSON.parse(emitted[0] as string) as Record<string, unknown>;
  assert.equal(parsed.level, "debug", "emitted line must carry level=debug");
  assert.equal(
    parsed.msg,
    "noisy detail",
    "emitted line must carry the debug message",
  );
});

test("logger_level: a higher-severity line is emitted while a lower one is suppressed", () => {
  // At level=warn: info suppressed, error emitted — proves severity ordering, not a blanket on/off.
  const lines = captureStdout(() => {
    const log = createLogger({ level: "warn" });
    log.info("below threshold");
    log.error("above threshold");
  });
  assert.equal(
    lines.length,
    1,
    `only the error line should survive at warn level, got ${lines.length}`,
  );
  const parsed = JSON.parse(lines[0] as string) as Record<string, unknown>;
  assert.equal(parsed.level, "error", "the surviving line must be the error");
  assert.equal(
    parsed.msg,
    "above threshold",
    "the surviving line must be the error message",
  );
});

test("logger: structured fields are merged into the JSON object", () => {
  const lines = captureStdout(() => {
    const log = createLogger({ level: "info" });
    log.info("request handled", { statusCode: 200, route: "/health" });
  });
  const parsed = JSON.parse(lines[0] as string) as Record<string, unknown>;
  assert.equal(parsed.statusCode, 200, "extra numeric field must be preserved");
  assert.equal(parsed.route, "/health", "extra string field must be preserved");
  // Core fields must still be present and must not be overwritten by merge.
  assert.equal(parsed.level, "info", "level must survive field merge");
  assert.equal(parsed.msg, "request handled", "msg must survive field merge");
});

test("logger: caller-supplied fields can NOT override the true level/msg/time", () => {
  // Distinguishing test for the field-merge ORDER. The correct impl spreads
  // caller fields FIRST so the real level/msg/time win. A reversed-order impl
  // (`{ level, time, msg, ...fields }`) would let a caller clobber those core
  // fields — a security/correctness hazard (a debug call could masquerade as an
  // error line, or hide its real timestamp). Passing colliding keys makes the
  // WRONG value distinct from the RIGHT one, so a reversed impl goes RED here.
  const frozen = new Date("2020-01-01T00:00:00.000Z");
  const lines = captureStdout(() => {
    const log = createLogger({ level: "info", now: () => frozen });
    log.warn("real message", {
      level: "SPOOFED_LEVEL",
      msg: "SPOOFED_MSG",
      time: "SPOOFED_TIME",
      // a genuine extra field alongside the collisions must still survive
      route: "/health",
    });
  });
  assert.equal(lines.length, 1, `expected one line, got ${lines.length}`);
  const parsed = JSON.parse(lines[0] as string) as Record<string, unknown>;
  assert.equal(
    parsed.level,
    "warn",
    `level must be the TRUE call level "warn", not the caller override; got ${String(parsed.level)}`,
  );
  assert.equal(
    parsed.msg,
    "real message",
    `msg must be the TRUE message, not the caller override; got ${String(parsed.msg)}`,
  );
  assert.equal(
    parsed.time,
    "2020-01-01T00:00:00.000Z",
    `time must be the TRUE clock value, not the caller override; got ${String(parsed.time)}`,
  );
  assert.equal(
    parsed.route,
    "/health",
    "a non-colliding caller field must still be preserved",
  );
});

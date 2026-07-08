import { test } from "node:test";
import assert from "node:assert/strict";

import { loadConfig } from "../src/config.ts";

test("config_defaults: reads PORT/LOG_LEVEL/NODE_ENV from env, falls back to defaults", () => {
  // Env-provided values win: a NON-DEFAULT port (8080, not the 3000 default)
  // so a hardcoded `return 3000` would go red here.
  const fromEnv = loadConfig({
    NODE_ENV: "production",
    PORT: "8080",
    LOG_LEVEL: "warn",
  });
  assert.equal(
    fromEnv.port,
    8080,
    `expected port 8080 from env, got ${fromEnv.port}`,
  );
  assert.equal(fromEnv.nodeEnv, "production", "nodeEnv must come from env");
  assert.equal(fromEnv.logLevel, "warn", "logLevel must come from env");

  // Absent vars fall back to the documented defaults.
  const defaults = loadConfig({});
  assert.equal(
    defaults.port,
    3000,
    `expected default port 3000, got ${defaults.port}`,
  );
  assert.equal(
    defaults.nodeEnv,
    "development",
    "nodeEnv default must be development",
  );
  assert.equal(defaults.logLevel, "info", "logLevel default must be info");
});

test("config_fail_fast: a non-numeric PORT throws a descriptive error (no silent coerce)", () => {
  // The lazy-wrong impl `Number(env.PORT)` yields NaN and ships it; this must throw.
  assert.throws(
    () => loadConfig({ PORT: "not-a-number" }),
    /PORT/,
    "invalid PORT must throw an error mentioning PORT",
  );
});

test("config_fail_fast: an out-of-range PORT (0 and 70000) throws", () => {
  // Boundary + just-outside on both sides: 1 and 65535 accepted, 0 and 65536 rejected.
  assert.equal(
    loadConfig({ PORT: "1" }).port,
    1,
    "port 1 is valid (low boundary)",
  );
  assert.equal(
    loadConfig({ PORT: "65535" }).port,
    65535,
    "port 65535 is valid (high boundary)",
  );
  assert.throws(
    () => loadConfig({ PORT: "0" }),
    /PORT/,
    "port 0 is out of range",
  );
  assert.throws(
    () => loadConfig({ PORT: "65536" }),
    /PORT/,
    "port 65536 is out of range",
  );
});

test("config_fail_fast: a non-integer PORT (3000.5) throws", () => {
  assert.throws(
    () => loadConfig({ PORT: "3000.5" }),
    /PORT/,
    "fractional port must be rejected",
  );
});

test("config_fail_fast: an unrecognized LOG_LEVEL throws a descriptive error", () => {
  assert.throws(
    () => loadConfig({ LOG_LEVEL: "verbose" }),
    /LOG_LEVEL/,
    "invalid LOG_LEVEL must throw an error mentioning LOG_LEVEL",
  );
});

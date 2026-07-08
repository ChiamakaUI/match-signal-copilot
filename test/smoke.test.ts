import { test } from "node:test";
import assert from "node:assert/strict";

import { STARTUP_MESSAGE, main } from "../src/index.ts";

test("smoke: TypeScript test harness executes and imports compiled source", () => {
  // Distinguishes the real entrypoint from an empty/stub module: asserts the
  // exact startup string the service emits, not merely that an export exists.
  assert.equal(STARTUP_MESSAGE, "match-signal-copilot: service starting");
});

test("smoke: main() runs without throwing and returns void", () => {
  const result = main();
  assert.equal(result, undefined);
});

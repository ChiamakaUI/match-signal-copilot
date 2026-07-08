import { test } from "node:test";
import assert from "node:assert/strict";

import { main } from "../src/index.ts";

test("smoke: TypeScript test harness executes and imports the entrypoint", () => {
  // Distinguishes the real entrypoint from an empty/stub module: `main` is the
  // production composition root that boots the HTTP service (see server.test.ts
  // for the behavioural coverage). Here we only assert the harness can import
  // and reference it — importing must NOT auto-start a server.
  assert.equal(typeof main, "function", "entrypoint must export main()");
});

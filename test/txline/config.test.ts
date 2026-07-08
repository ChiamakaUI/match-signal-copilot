import { test } from "node:test";
import assert from "node:assert/strict";

import { loadTxlineConfig } from "../../src/txline/config.ts";

test("requires-url: a missing TXLINE_SSE_URL throws naming the variable (no default)", () => {
  // The lazy-wrong impl returns a baked-in placeholder URL and connects anyway;
  // this must instead throw an error that names TXLINE_SSE_URL.
  assert.throws(
    () => loadTxlineConfig({ TXLINE_AUTH_TOKEN: "tok" }),
    /TXLINE_SSE_URL/,
    "missing TXLINE_SSE_URL must throw an error naming TXLINE_SSE_URL",
  );
  // A present-but-blank URL is just as unusable as an absent one.
  assert.throws(
    () => loadTxlineConfig({ TXLINE_SSE_URL: "   ", TXLINE_AUTH_TOKEN: "tok" }),
    /TXLINE_SSE_URL/,
    "blank TXLINE_SSE_URL must also throw",
  );
});

test("requires-token: a missing TXLINE_AUTH_TOKEN throws naming the variable (no unauth default)", () => {
  assert.throws(
    () => loadTxlineConfig({ TXLINE_SSE_URL: "https://feed.example/stream" }),
    /TXLINE_AUTH_TOKEN/,
    "missing TXLINE_AUTH_TOKEN must throw an error naming TXLINE_AUTH_TOKEN",
  );
});

test("happy: reads both variables into their own fields (distinct sentinels catch a swap)", () => {
  // Distinct values per field so a swapped mapping (url<->token) is caught.
  const cfg = loadTxlineConfig({
    TXLINE_SSE_URL: "https://feed.example/odds-stream",
    TXLINE_AUTH_TOKEN: "secret-token-abc",
  });
  assert.equal(
    cfg.sseUrl,
    "https://feed.example/odds-stream",
    `sseUrl must come from TXLINE_SSE_URL, got ${cfg.sseUrl}`,
  );
  assert.equal(
    cfg.authToken,
    "secret-token-abc",
    `authToken must come from TXLINE_AUTH_TOKEN, got ${cfg.authToken}`,
  );
});

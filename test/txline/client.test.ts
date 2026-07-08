import { test } from "node:test";
import assert from "node:assert/strict";

import {
  createTxlineClient,
  type ConnectRequest,
  type TxlineClient,
} from "../../src/txline/client.ts";
import type { Logger } from "../../src/logger.ts";
import type { RawSseEvent } from "../../src/txline/types.ts";

/** A logger that records nothing — used where log output is not asserted. */
const noopLogger: Logger = {
  debug() {},
  info() {},
  warn() {},
  error() {},
  log() {},
};

/** Build an async chunk stream that yields the given chunks then ends (drops). */
async function* chunkStream(
  ...chunks: Array<string | Uint8Array>
): AsyncIterable<string | Uint8Array> {
  for (const chunk of chunks) yield chunk;
}

const CONFIG = {
  sseUrl: "https://feed.example/odds-stream",
  authToken: "secret-token-abc",
} as const;

test("resumes-with-last-id: reconnect carries Last-Event-ID equal to the last id seen before the drop", async () => {
  const requests: ConnectRequest[] = [];
  const events: RawSseEvent[] = [];
  let client!: TxlineClient;

  client = createTxlineClient({
    config: CONFIG,
    logger: noopLogger,
    backoff: { baseMs: 1, capMs: 1 },
    onEvent: (event) => events.push(event),
    sleep: async () => {},
    connect: (req) => {
      requests.push(req);
      if (requests.length === 1) {
        // First connection: deliver one event carrying id "42", then drop.
        return { chunks: chunkStream("id: 42\ndata: hello\n\n") };
      }
      // Second connection is the reconnect we want to inspect: stop after it.
      client.stop();
      return { chunks: chunkStream() };
    },
  });

  await client.start();

  assert.equal(
    events.length,
    1,
    `expected exactly 1 event, got ${events.length}`,
  );
  assert.equal(
    events[0]?.id,
    "42",
    `expected event id "42", got ${events[0]?.id}`,
  );
  assert.ok(
    requests.length >= 2,
    `expected >=2 connect calls, got ${requests.length}`,
  );

  // The FIRST connection must not carry a resume header (nothing seen yet).
  assert.equal(
    requests[0]?.headers["Last-Event-ID"],
    undefined,
    "first connect must NOT carry Last-Event-ID",
  );
  // The reconnect must resume from the last id observed before the drop.
  assert.equal(
    requests[1]?.headers["Last-Event-ID"],
    "42",
    `reconnect must carry Last-Event-ID=42, got ${requests[1]?.headers["Last-Event-ID"]}`,
  );
  // And it must still authenticate.
  assert.equal(
    requests[1]?.headers["Authorization"],
    "Bearer secret-token-abc",
    "reconnect must present the auth token",
  );
});

test("backoff-grows: repeated failures back off with non-decreasing, capped delays (not fixed/zero)", async () => {
  const delays: number[] = [];
  let client!: TxlineClient;

  client = createTxlineClient({
    config: CONFIG,
    logger: noopLogger,
    // base 100, cap 400, factor 2 -> 100, 200, 400, 400, ...
    backoff: { baseMs: 100, capMs: 400, factor: 2 },
    onEvent: () => {},
    // Every connection drops immediately with zero events, so the backoff grows.
    connect: () => ({ chunks: chunkStream() }),
    sleep: async (ms) => {
      delays.push(ms);
      if (delays.length >= 4) client.stop();
    },
  });

  await client.start();

  assert.deepEqual(
    delays.slice(0, 4),
    [100, 200, 400, 400],
    `expected exponential-then-capped delays [100,200,400,400], got ${JSON.stringify(delays)}`,
  );
  // Non-decreasing (a fixed or reset-every-time impl would violate this).
  for (let i = 1; i < delays.length; i += 1) {
    assert.ok(
      (delays[i] ?? 0) >= (delays[i - 1] ?? 0),
      `delays must be non-decreasing at ${i}: ${JSON.stringify(delays)}`,
    );
  }
  // Never zero (a fixed/zero-delay impl would fail here).
  assert.ok(delays[0]! > 0, `first delay must be > 0, got ${delays[0]}`);
  // Capped: no delay exceeds the ceiling.
  assert.ok(
    Math.max(...delays) <= 400,
    `no delay may exceed cap 400, got ${JSON.stringify(delays)}`,
  );
  // Actually grew (an uncapped-or-fixed distinction): later delay > first.
  assert.ok(
    delays[2]! > delays[0]!,
    `delay must increase across attempts: ${JSON.stringify(delays)}`,
  );
});

test("errored-connection: a thrown connection error is logged with its detail and triggers reconnect", async () => {
  const requests: ConnectRequest[] = [];
  const warnings: Array<{ msg: string; error: unknown }> = [];
  const logger: Logger = {
    ...noopLogger,
    warn: (msg, fields) => warnings.push({ msg, error: fields?.error }),
  };
  let client!: TxlineClient;

  client = createTxlineClient({
    config: CONFIG,
    logger,
    backoff: { baseMs: 1, capMs: 1 },
    onEvent: () => {},
    sleep: async () => {},
    connect: (req) => {
      requests.push(req);
      if (requests.length === 1) {
        throw new Error("boom-ECONNRESET");
      }
      client.stop();
      return { chunks: chunkStream() };
    },
  });

  await client.start();

  assert.ok(
    requests.length >= 2,
    `error must trigger a reconnect, got ${requests.length} connects`,
  );
  assert.ok(
    warnings.length >= 1,
    "the connection error must be logged at warn",
  );
  assert.equal(
    typeof warnings[0]?.error,
    "string",
    "logged error detail must be a non-empty string, not swallowed",
  );
  assert.match(
    String(warnings[0]?.error),
    /ECONNRESET/,
    `warn must name the underlying error, got ${warnings[0]?.error}`,
  );
});

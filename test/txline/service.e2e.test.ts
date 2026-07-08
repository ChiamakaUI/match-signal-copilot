/**
 * End-to-end wiring test for the TxLINE ingestion service.
 *
 * These tests drive a SCRIPTED SSE byte stream through the REAL wired pipeline
 * (`startTxlineIngestion` builds the real client + real SSE parser + real
 * normalizer) — the ONLY injected collaborators are the network boundary
 * (`connect`) and the clock (`sleep`). Nothing about the pipeline internals is
 * faked, so a placeholder/stub composition root turns these RED.
 */

import { test } from "node:test";
import assert from "node:assert/strict";

import { startTxlineIngestion } from "../../src/txline/service.ts";
import { EventEmitterSink } from "../../src/txline/sink.ts";
import type { Logger } from "../../src/logger.ts";
import type { ConnectRequest } from "../../src/txline/client.ts";
import type { NormalizedMatchEvent } from "../../src/txline/types.ts";

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

/**
 * A scripted SSE frame with EVERY wire feature the AC calls for:
 *   - a keep-alive comment line (must be ignored),
 *   - an `id:` (must resume the stream),
 *   - an `event:` name,
 *   - a MULTI-LINE `data:` payload (joined with `\n` before JSON.parse).
 * Each normalized field carries a DISTINCT, recognisable value so a swapped or
 * dropped field mapping is visible.
 */
const VALID_FRAME =
  ": keep-alive\n" +
  "id: 1001\n" +
  "event: odds_update\n" +
  'data: {"eventType":"odds_update",\n' +
  'data: "matchId":"m-77",\n' +
  'data: "oddsBefore":1.5,"oddsAfter":2.25,"timestamp":1700000000123}\n' +
  "\n";

test("end-to-end -> sink receives the normalized record whose fields equal the scripted frame's values", async () => {
  const sink = new EventEmitterSink<NormalizedMatchEvent>();
  const received: NormalizedMatchEvent[] = [];
  sink.subscribe((e) => received.push(e));

  let ingestion!: ReturnType<typeof startTxlineIngestion>;
  ingestion = startTxlineIngestion(sink, {
    config: CONFIG,
    logger: noopLogger,
    backoff: { baseMs: 1, capMs: 1 },
    sleep: async () => {},
    connect: (_req: ConnectRequest) => {
      // Deliver the scripted frame once, then stop so the loop exits.
      ingestion.stop();
      return { chunks: chunkStream(VALID_FRAME) };
    },
  });

  await ingestion.done;

  assert.equal(
    received.length,
    1,
    `expected exactly 1 normalized record, got ${received.length}`,
  );
  const rec = received[0]!;
  assert.equal(
    rec.eventType,
    "odds_update",
    `eventType must equal scripted value, got ${rec.eventType}`,
  );
  assert.equal(
    rec.matchId,
    "m-77",
    `matchId must equal scripted value, got ${rec.matchId}`,
  );
  assert.equal(
    rec.oddsBefore,
    1.5,
    `oddsBefore must equal scripted value, got ${rec.oddsBefore}`,
  );
  assert.equal(
    rec.oddsAfter,
    2.25,
    `oddsAfter must equal scripted value, got ${rec.oddsAfter}`,
  );
  assert.equal(
    rec.timestamp,
    1700000000123,
    `timestamp must equal scripted value, got ${rec.timestamp}`,
  );
});

test("e2e-skips-bad -> sink count equals the valid-frame count, not the total frame count", async () => {
  const sink = new EventEmitterSink<NormalizedMatchEvent>();
  const received: NormalizedMatchEvent[] = [];
  sink.subscribe((e) => received.push(e));

  const warnings: string[] = [];
  const logger: Logger = {
    ...noopLogger,
    warn: (msg) => warnings.push(msg),
  };

  // Three frames: valid, MALFORMED (invalid JSON), valid. The bad one must be
  // skipped-and-logged while BOTH surrounding valid frames reach the sink.
  const secondValid =
    'id: 1002\ndata: {"eventType":"match_start","matchId":"m-88",' +
    '"oddsBefore":3,"oddsAfter":4,"timestamp":1700000000999}\n\n';
  const malformed = "id: bad\ndata: {not-json,,,}\n\n";

  let ingestion!: ReturnType<typeof startTxlineIngestion>;
  ingestion = startTxlineIngestion(sink, {
    config: CONFIG,
    logger,
    backoff: { baseMs: 1, capMs: 1 },
    sleep: async () => {},
    connect: (_req: ConnectRequest) => {
      ingestion.stop();
      return { chunks: chunkStream(VALID_FRAME + malformed + secondValid) };
    },
  });

  await ingestion.done;

  // Three frames in; exactly TWO (the valid ones) reach the sink.
  assert.equal(
    received.length,
    2,
    `sink count must equal valid-frame count (2), not total (3); got ${received.length}`,
  );
  assert.deepEqual(
    received.map((r) => r.matchId),
    ["m-77", "m-88"],
    `only the two valid frames may reach the sink, got ${JSON.stringify(received.map((r) => r.matchId))}`,
  );
  // The malformed frame must have been surfaced (logged), not silently dropped.
  assert.ok(
    warnings.length >= 1,
    "the malformed frame must be logged at warn (skip-and-log)",
  );
});

test("e2e-reconnect -> records received after the drop and Last-Event-ID header equals the pre-drop id", async () => {
  const sink = new EventEmitterSink<NormalizedMatchEvent>();
  const received: NormalizedMatchEvent[] = [];
  sink.subscribe((e) => received.push(e));
  const requests: ConnectRequest[] = [];

  const postDrop =
    'id: 2002\ndata: {"eventType":"odds_update","matchId":"m-post",' +
    '"oddsBefore":5,"oddsAfter":6,"timestamp":1700000001000}\n\n';

  let ingestion!: ReturnType<typeof startTxlineIngestion>;
  ingestion = startTxlineIngestion(sink, {
    config: CONFIG,
    logger: noopLogger,
    backoff: { baseMs: 1, capMs: 1 },
    sleep: async () => {},
    connect: (req: ConnectRequest) => {
      requests.push(req);
      if (requests.length === 1) {
        // First connection: deliver the valid frame (id 1001) then DROP.
        return { chunks: chunkStream(VALID_FRAME) };
      }
      // Reconnect: deliver one more record, then stop the loop.
      ingestion.stop();
      return { chunks: chunkStream(postDrop) };
    },
  });

  await ingestion.done;

  assert.ok(
    requests.length >= 2,
    `a drop must trigger a reconnect, got ${requests.length} connects`,
  );
  // The FIRST connection must NOT carry a resume header (nothing seen yet).
  assert.equal(
    requests[0]?.headers["Last-Event-ID"],
    undefined,
    "first connect must NOT carry Last-Event-ID",
  );
  // The reconnect must resume from the id seen before the drop.
  assert.equal(
    requests[1]?.headers["Last-Event-ID"],
    "1001",
    `reconnect must carry Last-Event-ID=1001, got ${requests[1]?.headers["Last-Event-ID"]}`,
  );
  // Records were delivered on BOTH sides of the drop, end-to-end.
  assert.deepEqual(
    received.map((r) => r.matchId),
    ["m-77", "m-post"],
    `records must be delivered before AND after the reconnect, got ${JSON.stringify(received.map((r) => r.matchId))}`,
  );
});

test("default connect uses the real network boundary (fetch), not a no-op stub", async () => {
  // Verify the PRODUCTION default: when `connect` is omitted, the service must
  // open a real fetch-based SSE connection — not silently do nothing. We stub
  // only the external `fetch` boundary and prove it is actually called with the
  // configured URL + auth header, then feed one scripted frame back through the
  // real pipeline.
  const sink = new EventEmitterSink<NormalizedMatchEvent>();
  const received: NormalizedMatchEvent[] = [];
  sink.subscribe((e) => received.push(e));

  const fetchCalls: Array<{ url: string; headers: Record<string, string> }> =
    [];
  const originalFetch = globalThis.fetch;

  // A ReadableStream body carrying the scripted frame as UTF-8 bytes.
  function bodyFor(text: string): ReadableStream<Uint8Array> {
    const bytes = new TextEncoder().encode(text);
    return new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(bytes);
        controller.close();
      },
    });
  }

  let ingestion!: ReturnType<typeof startTxlineIngestion>;
  globalThis.fetch = (async (
    input: string | URL | Request,
    init?: RequestInit,
  ) => {
    fetchCalls.push({
      url: String(input),
      headers: (init?.headers ?? {}) as Record<string, string>,
    });
    // Stop the loop so it does not reconnect after this scripted body ends.
    ingestion.stop();
    return new Response(bodyFor(VALID_FRAME), { status: 200 });
  }) as typeof fetch;

  try {
    ingestion = startTxlineIngestion(sink, {
      config: CONFIG,
      logger: noopLogger,
      backoff: { baseMs: 1, capMs: 1 },
      sleep: async () => {},
      // connect deliberately omitted -> exercises the real default.
    });
    await ingestion.done;
  } finally {
    globalThis.fetch = originalFetch;
  }

  assert.ok(
    fetchCalls.length >= 1,
    `default connect must call fetch, got ${fetchCalls.length} calls`,
  );
  assert.equal(
    fetchCalls[0]?.url,
    CONFIG.sseUrl,
    `default connect must fetch the configured SSE URL, got ${fetchCalls[0]?.url}`,
  );
  assert.equal(
    fetchCalls[0]?.headers["Authorization"],
    `Bearer ${CONFIG.authToken}`,
    "default connect must present the configured auth token",
  );
  // And the scripted body flowed through the REAL parser + normalizer to sink.
  assert.equal(
    received.length,
    1,
    `the real default pipeline must deliver the scripted record, got ${received.length}`,
  );
  assert.equal(received[0]?.matchId, "m-77");
});

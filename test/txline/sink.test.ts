import { test } from "node:test";
import assert from "node:assert/strict";

import { EventEmitterSink } from "../../src/txline/sink.ts";
import type {
  NormalizedMatchEvent,
  RawSseEvent,
} from "../../src/txline/types.ts";

// Two deliberately DISTINCT records so a swapped/dropped field or a reordered
// delivery is observable. rec1 exercises the single-value arm of the odds
// union; rec2 exercises the keyed-record (one-or-many) arm. Distinct matchId,
// eventType and timestamp values let assertions name exactly what diverged.
const rec1: NormalizedMatchEvent = {
  eventType: "odds_update",
  matchId: "match-1",
  oddsBefore: 1.9,
  oddsAfter: 2.1,
  timestamp: 1000,
};

const rec2: NormalizedMatchEvent = {
  eventType: "match_start",
  matchId: "match-2",
  oddsBefore: { home: 1.5, draw: 3.4, away: 2.7 },
  oddsAfter: { home: 1.4, draw: 3.6, away: 2.9 },
  timestamp: 2000,
};

test("emits-to-subscriber: both records received in push order", () => {
  const sink = new EventEmitterSink<NormalizedMatchEvent>();
  const received: NormalizedMatchEvent[] = [];
  sink.subscribe((e) => received.push(e));

  sink.push(rec1);
  sink.push(rec2);

  assert.equal(
    received.length,
    2,
    `expected 2 deliveries, got ${received.length}`,
  );
  // Order matters: rec1 pushed first must arrive first. A LIFO or unordered
  // delivery makes this go red.
  assert.equal(
    received[0]?.matchId,
    "match-1",
    "first delivered record must be rec1",
  );
  assert.equal(
    received[1]?.matchId,
    "match-2",
    "second delivered record must be rec2",
  );
  assert.deepEqual(received[0], rec1, "first delivery must deep-equal rec1");
  assert.deepEqual(received[1], rec2, "second delivery must deep-equal rec2");
});

test("emits-to-subscriber: unsubscribe stops further deliveries", () => {
  const sink = new EventEmitterSink<NormalizedMatchEvent>();
  const received: NormalizedMatchEvent[] = [];
  const sub = sink.subscribe((e) => received.push(e));

  sink.push(rec1);
  sub.unsubscribe();
  sink.push(rec2);

  assert.equal(
    received.length,
    1,
    `expected 1 delivery after unsubscribe, got ${received.length}`,
  );
  assert.equal(
    received[0]?.matchId,
    "match-1",
    "only rec1 (pre-unsubscribe) should be delivered",
  );
});

test("async-iterator-yields: collected array deep-equals pushed records", async () => {
  const sink = new EventEmitterSink<NormalizedMatchEvent>();
  // Register the async-iterator consumer BEFORE pushing so buffered items are
  // captured; close() terminates the loop after the final push.
  const iterator = sink[Symbol.asyncIterator]();

  const pushed: NormalizedMatchEvent[] = [rec1, rec2];
  for (const r of pushed) sink.push(r);
  sink.close();

  const collected: NormalizedMatchEvent[] = [];
  for await (const item of { [Symbol.asyncIterator]: () => iterator }) {
    collected.push(item);
  }

  assert.deepEqual(
    collected,
    pushed,
    "async iterator must yield each pushed record exactly once, in order",
  );
});

test("async-iterator-yields: item pushed after consumer waits is delivered exactly once", async () => {
  const sink = new EventEmitterSink<NormalizedMatchEvent>();
  const iterator = sink[Symbol.asyncIterator]();

  // Consumer parks on next() with an empty buffer; the later push must wake it.
  const firstNext = iterator.next();
  sink.push(rec1);
  const first = await firstNext;
  assert.equal(
    first.done,
    false,
    "iterator must yield the pushed record, not complete",
  );
  assert.equal((first.value as NormalizedMatchEvent).matchId, "match-1");

  sink.close();
  const end = await iterator.next();
  assert.equal(end.done, true, "iterator must complete after close()");
});

test("RawSseEvent carries data with optional event/id fields", () => {
  const raw: RawSseEvent = { event: "odds", data: "line1\nline2", id: "42" };
  assert.equal(raw.data, "line1\nline2");
  assert.equal(raw.event, "odds");
  assert.equal(raw.id, "42");

  const minimal: RawSseEvent = { data: "keepalive" };
  assert.equal(minimal.data, "keepalive");
  assert.equal(minimal.event, undefined);
});

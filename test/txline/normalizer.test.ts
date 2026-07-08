import { test } from "node:test";
import assert from "node:assert/strict";

import { EventEmitterSink } from "../../src/txline/sink.ts";
import { createNormalizer } from "../../src/txline/normalizer.ts";
import type {
  NormalizedMatchEvent,
  RawSseEvent,
} from "../../src/txline/types.ts";

/**
 * Minimal warn-capturing logger (the logger is an injected boundary). Records
 * each warn call's msg + fields so tests can assert exactly one skip was logged.
 */
function spyLogger(): {
  warn(msg: string, fields?: Record<string, unknown>): void;
  calls: Array<{ msg: string; fields?: Record<string, unknown> }>;
} {
  const calls: Array<{ msg: string; fields?: Record<string, unknown> }> = [];
  return {
    calls,
    warn(msg, fields): void {
      calls.push({ msg, fields });
    },
  };
}

/** Wire (real EventEmitterSink) capture harness: returns [sink, received]. */
function harness(): {
  sink: EventEmitterSink<NormalizedMatchEvent>;
  received: NormalizedMatchEvent[];
} {
  const sink = new EventEmitterSink<NormalizedMatchEvent>();
  const received: NormalizedMatchEvent[] = [];
  sink.subscribe((e) => received.push(e));
  return { sink, received };
}

// A well-formed TxLINE payload with DISTINCT recognizable values per field, so a
// swapped/dropped mapping yields a wrong record. `extra` must NOT leak through.
function validData(): string {
  return JSON.stringify({
    eventType: "odds_update",
    matchId: "match-42",
    oddsBefore: 1.9,
    oddsAfter: 2.1,
    timestamp: 1712574000000,
    extra: "must-not-leak",
  });
}

const validExpected: NormalizedMatchEvent = {
  eventType: "odds_update",
  matchId: "match-42",
  oddsBefore: 1.9,
  oddsAfter: 2.1,
  timestamp: 1712574000000,
};

test("maps-fields: well-formed payload normalizes and is pushed to the sink", () => {
  const { sink, received } = harness();
  const logger = spyLogger();
  const normalize = createNormalizer({ sink, logger });

  const raw: RawSseEvent = { event: "message", id: "evt-7", data: validData() };
  normalize(raw);

  assert.equal(
    received.length,
    1,
    `expected exactly one record on the sink, got ${received.length}`,
  );
  // deep-equal proves every field is mapped from its source and NO extra field
  // (e.g. the wire `extra`) leaks through a pass-through/spread implementation.
  assert.deepEqual(received[0], validExpected);
  assert.equal(
    logger.calls.length,
    0,
    `no warn expected for a well-formed payload, got ${logger.calls.length}`,
  );
});

test("maps-fields-keyed: the one-or-many keyed odds arm normalizes intact", () => {
  const { sink, received } = harness();
  const logger = spyLogger();
  const normalize = createNormalizer({ sink, logger });

  const before = { home: 1.5, draw: 3.4, away: 2.7 };
  const after = { home: 1.4, draw: 3.6, away: 2.9 };
  normalize({
    data: JSON.stringify({
      eventType: "match_start",
      matchId: "match-9",
      oddsBefore: before,
      oddsAfter: after,
      timestamp: 2000,
    }),
  });

  assert.equal(
    received.length,
    1,
    `expected one record, got ${received.length}`,
  );
  assert.deepEqual(received[0], {
    eventType: "match_start",
    matchId: "match-9",
    oddsBefore: before,
    oddsAfter: after,
    timestamp: 2000,
  });
});

test("skips-malformed: invalid JSON is skipped, warns once, does not throw", () => {
  const { sink, received } = harness();
  const logger = spyLogger();
  const normalize = createNormalizer({ sink, logger });

  assert.doesNotThrow(() => normalize({ data: "{ this is not json" }));

  assert.equal(
    received.length,
    0,
    `sink must receive nothing for invalid JSON, got ${received.length}`,
  );
  assert.equal(
    logger.calls.length,
    1,
    `expected exactly one warn for invalid JSON, got ${logger.calls.length}`,
  );
});

test("skip-then-continue: missing matchId is skipped; a later valid event still normalizes", () => {
  const { sink, received } = harness();
  const logger = spyLogger();
  const normalize = createNormalizer({ sink, logger });

  // First event omits matchId -> must be skipped-and-logged.
  normalize({
    data: JSON.stringify({
      eventType: "odds_update",
      oddsBefore: 1.9,
      oddsAfter: 2.1,
      timestamp: 1712574000000,
    }),
  });
  // Second event is valid -> must normalize.
  normalize({ data: validData() });

  assert.equal(
    received.length,
    1,
    `expected exactly the one valid record, got ${received.length}`,
  );
  assert.deepEqual(received[0], validExpected);
  assert.equal(
    logger.calls.length,
    1,
    `expected exactly one warn (for the skipped event), got ${logger.calls.length}`,
  );
});

// ONE FIXTURE PER REQUIRED-FIELD ARM: omitting ANY required field must skip.
// A lazy impl that validates only matchId (or none) goes RED here.
const REQUIRED_FIELDS = [
  "eventType",
  "matchId",
  "oddsBefore",
  "oddsAfter",
  "timestamp",
] as const;

for (const field of REQUIRED_FIELDS) {
  test(`skips-missing-${field}: omitting a required field skips-and-warns`, () => {
    const { sink, received } = harness();
    const logger = spyLogger();
    const normalize = createNormalizer({ sink, logger });

    const full: Record<string, unknown> = {
      eventType: "odds_update",
      matchId: "match-42",
      oddsBefore: 1.9,
      oddsAfter: 2.1,
      timestamp: 1712574000000,
    };
    delete full[field];

    normalize({ data: JSON.stringify(full) });

    assert.equal(
      received.length,
      0,
      `omitting ${field} must push nothing, got ${received.length}`,
    );
    assert.equal(
      logger.calls.length,
      1,
      `omitting ${field} must warn once, got ${logger.calls.length}`,
    );
  });
}

test("skips-wrong-type: a non-string matchId (number) is treated as invalid", () => {
  const { sink, received } = harness();
  const logger = spyLogger();
  const normalize = createNormalizer({ sink, logger });

  normalize({
    data: JSON.stringify({
      eventType: "odds_update",
      matchId: 42, // wrong type -> not a valid matchId
      oddsBefore: 1.9,
      oddsAfter: 2.1,
      timestamp: 1712574000000,
    }),
  });

  assert.equal(received.length, 0, `wrong-typed matchId must be skipped`);
  assert.equal(logger.calls.length, 1, `wrong-typed matchId must warn once`);
});

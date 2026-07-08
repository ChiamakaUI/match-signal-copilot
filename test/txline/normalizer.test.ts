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

/**
 * Assert the logger recorded EXACTLY one warn and return its recorded fields.
 * Centralizes the "skips are observable" contract: callers then assert the
 * concrete `reason` / `fields` content, not merely that a warn happened — so an
 * implementation that logs a constant or wrong reason for every skip goes RED.
 */
function soleWarnFields(logger: {
  calls: Array<{ msg: string; fields?: Record<string, unknown> }>;
}): Record<string, unknown> {
  assert.equal(
    logger.calls.length,
    1,
    `expected exactly one warn, got ${logger.calls.length}`,
  );
  const { msg, fields } = logger.calls[0];
  assert.equal(
    msg,
    "txline.normalize: skipping malformed match event payload",
    `unexpected warn message: ${msg}`,
  );
  assert.ok(fields, "warn must carry a structured fields object");
  return fields as Record<string, unknown>;
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
  // Assert the CONCRETE reason, not just that a warn happened: a constant/wrong
  // reason (or the field-validation reason) goes RED here.
  const fields = soleWarnFields(logger);
  assert.equal(
    fields.reason,
    "invalid_json",
    `invalid JSON must warn reason "invalid_json", got ${String(fields.reason)}`,
  );
});

// TOP-LEVEL JSON THAT PARSES TO A NON-OBJECT.
//
// These payloads are valid JSON but NOT a JSON object: `null`, an array, a bare
// number/string/boolean. A lazy implementation that omits the
// `typeof parsed !== "object" || parsed === null || Array.isArray(parsed)` guard
// and casts `parsed` straight to a record either THROWS (`null.eventType` on the
// `"null"` payload — violating the module's "never throws" contract) or misroutes
// the skip to the field-validation reason. Both are caught below: no throw, sink
// empty, one warn whose reason is specifically "not_an_object".
const NON_OBJECT_PAYLOADS: Array<{ data: string; note: string }> = [
  { data: "null", note: "null" },
  { data: "[1,2,3]", note: "array" },
  { data: "5", note: "bare number" },
  { data: '"str"', note: "bare string" },
  { data: "true", note: "bare boolean" },
];

for (const { data, note } of NON_OBJECT_PAYLOADS) {
  test(`skips-non-object-${note}: a top-level non-object JSON payload (${note}) is skipped without throwing`, () => {
    const { sink, received } = harness();
    const logger = spyLogger();
    const normalize = createNormalizer({ sink, logger });

    // Must NOT throw — this is the untrusted-input path; `null.eventType` on an
    // unguarded impl would crash here and fail this assertion.
    assert.doesNotThrow(() => normalize({ data }));

    assert.equal(
      received.length,
      0,
      `non-object payload (${note}) must push nothing, got ${received.length}`,
    );
    const fields = soleWarnFields(logger);
    assert.equal(
      fields.reason,
      "not_an_object",
      `non-object payload (${note}) must warn reason "not_an_object", got ${String(fields.reason)}`,
    );
  });
}

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
  // The one warn must name the field-validation reason AND list the missing
  // field, so it is genuinely observable/diagnosable downstream.
  const fields = soleWarnFields(logger);
  assert.equal(
    fields.reason,
    "missing_or_invalid_fields",
    `missing matchId must warn reason "missing_or_invalid_fields", got ${String(fields.reason)}`,
  );
  assert.deepEqual(
    fields.fields,
    ["matchId"],
    `warn must name exactly the missing field, got ${JSON.stringify(fields.fields)}`,
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
    const logged = soleWarnFields(logger);
    assert.equal(
      logged.reason,
      "missing_or_invalid_fields",
      `omitting ${field} must warn reason "missing_or_invalid_fields", got ${String(logged.reason)}`,
    );
    // The warn must NAME the offending field (not a constant/empty list), so an
    // impl that logs a fixed field-list for every skip goes RED here.
    assert.ok(
      Array.isArray(logged.fields) &&
        (logged.fields as string[]).includes(field),
      `omitting ${field} must record it in fields, got ${JSON.stringify(logged.fields)}`,
    );
  });
}

// ONE FIXTURE PER FIELD × WRONG-TYPE ARM.
//
// Each entry replaces exactly ONE field of an otherwise-valid payload with a
// value that is PRESENT (not `undefined`) but WRONG-TYPED / empty. This is the
// key distinguishing set: a lazy implementation that validates mere PRESENCE
// (`field !== undefined`) instead of real type + non-emptiness checks would
// happily push these records, so it goes RED here. The `undefined`-only
// "missing field" tests above cannot catch that class on their own.
//
// Values chosen so each also probes the SPECIFIC validator:
//   - "" defeats non-empty-string checks that a `typeof === "string"` alone passes.
//   - {} / {home:"x"} defeat a shallow `typeof === "object"` odds check (empty
//     record, and a keyed record whose value is not a finite number).
//   - null defeats a presence check (null !== undefined) for both odds arms.
//   - a numeric string / boolean for timestamp defeats a coerce-y check.
const WRONG_TYPED: Array<{ field: string; value: unknown; note: string }> = [
  { field: "eventType", value: "", note: "empty string" },
  { field: "eventType", value: 5, note: "number" },
  { field: "eventType", value: null, note: "null" },
  { field: "matchId", value: 42, note: "number" },
  { field: "matchId", value: "", note: "empty string" },
  { field: "matchId", value: null, note: "null" },
  { field: "oddsBefore", value: "1.9", note: "numeric string" },
  { field: "oddsBefore", value: {}, note: "empty record" },
  {
    field: "oddsBefore",
    value: { home: "high" },
    note: "keyed record, non-number value",
  },
  { field: "oddsBefore", value: null, note: "null" },
  { field: "oddsAfter", value: "2.1", note: "numeric string" },
  { field: "oddsAfter", value: true, note: "boolean" },
  { field: "oddsAfter", value: [], note: "array" },
  { field: "oddsAfter", value: null, note: "null" },
  { field: "timestamp", value: "1712574000000", note: "numeric string" },
  { field: "timestamp", value: false, note: "boolean" },
  { field: "timestamp", value: null, note: "null" },
];

for (const { field, value, note } of WRONG_TYPED) {
  test(`skips-wrong-type-${field}-${note}: a present-but-wrong-typed ${field} (${note}) is skipped`, () => {
    const { sink, received } = harness();
    const logger = spyLogger();
    const normalize = createNormalizer({ sink, logger });

    const payload: Record<string, unknown> = {
      eventType: "odds_update",
      matchId: "match-42",
      oddsBefore: 1.9,
      oddsAfter: 2.1,
      timestamp: 1712574000000,
    };
    payload[field] = value;

    assert.doesNotThrow(() => normalize({ data: JSON.stringify(payload) }));

    assert.equal(
      received.length,
      0,
      `wrong-typed ${field} (${note}) must push nothing, got ${received.length}`,
    );
    const logged = soleWarnFields(logger);
    assert.equal(
      logged.reason,
      "missing_or_invalid_fields",
      `wrong-typed ${field} (${note}) must warn reason "missing_or_invalid_fields", got ${String(logged.reason)}`,
    );
    // The offending field must appear in the recorded field-list, proving the
    // skip is diagnosable down to which field failed validation.
    assert.ok(
      Array.isArray(logged.fields) &&
        (logged.fields as string[]).includes(field),
      `wrong-typed ${field} (${note}) must record it in fields, got ${JSON.stringify(logged.fields)}`,
    );
  });
}

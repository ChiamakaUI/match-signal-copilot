import { test } from "node:test";
import assert from "node:assert/strict";

import { SseParser } from "../../src/txline/sse-parser.ts";
import type { RawSseEvent } from "../../src/txline/types.ts";

test("multiline-frame: event + multi-line data + id parse to one RawSseEvent", () => {
  const parser = new SseParser();
  // Distinct values on every field so a swapped mapping (event<->id) is caught,
  // and two data: lines so a wrong join separator is caught.
  const events = parser.write(
    "event: odds\ndata: line1\ndata: line2\nid: 42\n\n",
  );

  assert.equal(events.length, 1, `expected 1 event, got ${events.length}`);
  const expected: RawSseEvent = {
    event: "odds",
    data: "line1\nline2",
    id: "42",
  };
  assert.deepEqual(
    events[0],
    expected,
    "frame must map event/id and join data lines with \\n",
  );
});

test("ignores-keepalive: comment lines produce no event and do not corrupt the following data", () => {
  const parser = new SseParser();
  // A `:`-prefixed comment sits BETWEEN two data lines of the same frame; it
  // must be dropped without breaking the join, and must not itself dispatch.
  const events = parser.write("data: a\n: keep-alive ping\ndata: b\nid: 9\n\n");

  assert.equal(events.length, 1, `expected 1 event, got ${events.length}`);
  const expected: RawSseEvent = { data: "a\nb", id: "9" };
  assert.deepEqual(
    events[0],
    expected,
    "comment must be ignored; data lines a and b must join with \\n",
  );
});

test("partial-chunk: a frame split mid-field parses to exactly one event after the second chunk", () => {
  const parser = new SseParser();

  const afterChunk1 = parser.write("event: od");
  assert.equal(
    afterChunk1.length,
    0,
    `no event should dispatch mid-frame, got ${afterChunk1.length}`,
  );

  const afterChunk2 = parser.write("ds\ndata: hello\n\n");
  assert.equal(
    afterChunk2.length,
    1,
    `exactly one event after the frame completes, got ${afterChunk2.length}`,
  );
  const expected: RawSseEvent = { event: "odds", data: "hello" };
  assert.deepEqual(
    afterChunk2[0],
    expected,
    "the split `event:` field must rejoin to `odds`",
  );
});

test("resets-between-frames: two frames in one chunk stay independent", () => {
  const parser = new SseParser();
  // Distinguishes an impl that never resets its data buffer: without a reset,
  // the second event's data would be "one\ntwo".
  const events = parser.write("data: one\n\ndata: two\n\n");

  assert.equal(events.length, 2, `expected 2 events, got ${events.length}`);
  assert.deepEqual(
    events[0],
    { data: "one" },
    "first frame carries only 'one'",
  );
  assert.deepEqual(
    events[1],
    { data: "two" },
    "second frame carries only 'two'",
  );
});

test("crlf-split: a CRLF terminator split across chunks still parses one event", () => {
  const parser = new SseParser();
  // The \r ends chunk 1, the \n opens chunk 2 — a naive splitter would treat
  // the lone \r as end-of-line and then the leading \n as a second blank line.
  const afterChunk1 = parser.write("data: x\r");
  assert.equal(afterChunk1.length, 0, "no dispatch until the frame closes");

  const afterChunk2 = parser.write("\n\r\n");
  assert.equal(
    afterChunk2.length,
    1,
    `expected 1 event across the CRLF split, got ${afterChunk2.length}`,
  );
  assert.deepEqual(afterChunk2[0], { data: "x" }, "CRLF must not corrupt data");
});

test("leading-space: exactly one space after the colon is stripped", () => {
  const parser = new SseParser();
  // Two leading spaces -> only one stripped, so the value keeps a leading space.
  const events = parser.write("data:  spaced\n\n");
  assert.equal(events.length, 1);
  assert.deepEqual(
    events[0],
    { data: " spaced" },
    "only the first space after `:` is part of the field separator",
  );
});

test("byte-chunks: Uint8Array input decodes and parses like text", () => {
  const parser = new SseParser();
  const bytes = new TextEncoder().encode("event: b\ndata: hi\n\n");
  const events = parser.write(bytes);
  assert.equal(events.length, 1);
  assert.deepEqual(events[0], { event: "b", data: "hi" });
});

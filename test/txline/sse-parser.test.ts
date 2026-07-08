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

test("comment-only-frame: a data-less comment frame emits nothing and does not corrupt the next real frame", () => {
  const parser = new SseParser();
  // A `:`-comment line closed by a blank line is a COMPLETE frame that carries
  // no `data:` field. The SSE dispatch algorithm emits nothing for it. This is
  // the "produce no event" half of the keep-alive AC that a frame-sandwiched
  // comment cannot prove: if dispatch fired on every blank line regardless of
  // accumulated data, this standalone comment frame would wrongly emit {data:""}.
  const afterComment = parser.write(": keep-alive ping\n\n");
  assert.equal(
    afterComment.length,
    0,
    `a data-less comment frame must emit nothing, got ${afterComment.length}: ${JSON.stringify(afterComment)}`,
  );

  // A bare `id:`-only frame (no data) likewise dispatches nothing per the spec.
  const afterBareId = parser.write("id: 5\n\n");
  assert.equal(
    afterBareId.length,
    0,
    `a data-less id-only frame must emit nothing, got ${afterBareId.length}: ${JSON.stringify(afterBareId)}`,
  );

  // The real frame that follows must be entirely unaffected by the dropped frames.
  const afterReal = parser.write("event: odds\ndata: real\nid: 7\n\n");
  assert.equal(
    afterReal.length,
    1,
    `expected exactly 1 real event, got ${afterReal.length}`,
  );
  assert.deepEqual(
    afterReal[0],
    { event: "odds", data: "real", id: "7" },
    "the real frame following data-less frames must parse cleanly",
  );
});

test("no-cross-frame-leak: a later frame omitting event/id does not inherit the prior frame's", () => {
  const parser = new SseParser();
  // Frame 1 carries a distinct event name AND id. Frame 2 supplies ONLY data,
  // omitting both event and id. A parser that fails to reset eventName/id on
  // dispatch leaks "first"/"100" into frame 2 — a core streaming-parser bug that
  // every same-value multi-frame test misses.
  const events = parser.write("event: first\ndata: a\nid: 100\n\ndata: b\n\n");

  assert.equal(events.length, 2, `expected 2 events, got ${events.length}`);
  assert.deepEqual(
    events[0],
    { event: "first", data: "a", id: "100" },
    "frame 1 keeps its own event/id",
  );
  assert.deepEqual(
    events[1],
    { data: "b" },
    "frame 2 omits event/id and must NOT inherit frame 1's 'first'/'100'",
  );
});

test("dataless-frame-no-leak: a data-less event/id frame leaks nothing into the next data-only frame", () => {
  const parser = new SseParser();
  // Frame 1 carries `event:` and `id:` but NO `data:`, so it dispatches nothing
  // AND leaves hasData=false. Frame 2 supplies ONLY data. The distinguishing
  // property: a parser that resets eventName/id only INSIDE `if (this.hasData)`
  // never runs the reset for frame 1 (hasData is false), so frame 1's
  // "leaked"/"99" bleed into frame 2. Every same-value / data-carrying multi-
  // frame test misses this exact variant of the cross-frame-leak class.
  const events = parser.write("event: leaked\nid: 99\n\ndata: b\n\n");

  assert.equal(events.length, 1, `expected 1 event, got ${events.length}`);
  assert.deepEqual(
    events[0],
    { data: "b" },
    "the data-only frame must NOT inherit the prior data-less frame's event 'leaked' / id '99'",
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

/**
 * Streaming parser for the SSE (Server-Sent Events) wire format.
 *
 * This layer is pure and networking-free: you feed it text or byte chunks as
 * they arrive off the wire, and it hands back the {@link RawSseEvent} frames
 * that have completed so far. It is streaming-friendly — a single feed frame
 * may be split across several {@link SseParser.write} calls and is only emitted
 * once its terminating blank line has been seen.
 *
 * What it implements from the SSE grammar:
 *   - `event:`, `data:`, `id:` fields (a single leading space after the colon
 *     is stripped, per the spec);
 *   - multi-line `data:` — several `data:` lines are joined with `\n`;
 *   - dispatch on a blank line;
 *   - comment lines (starting with `:`) are ignored;
 *   - line terminators `\n`, `\r\n` and lone `\r`, including a `\r\n` pair split
 *     across two chunks;
 *   - partial fields buffered across `write` calls.
 *
 * What it deliberately does NOT do: it does not interpret the `data` payload
 * (JSON parsing / malformed-payload handling lives in the normalizer), and it
 * does not track `Last-Event-ID` across frames — `id` is reported per-frame and
 * the reconnect client owns resume state.
 */

import type { RawSseEvent } from "./types.ts";

export class SseParser {
  /** Bytes/text received but not yet terminated by a line boundary. */
  private buffer = "";
  /** `data:` values collected for the frame currently being assembled. */
  private dataLines: string[] = [];
  /** True once any `data:` field has been seen for the current frame. */
  private hasData = false;
  /** The `event:` field of the current frame, if seen. */
  private eventName: string | undefined = undefined;
  /** The `id:` field of the current frame, if seen. */
  private id: string | undefined = undefined;
  /** Decoder for byte input; kept across calls so multi-byte chars can split. */
  private readonly decoder = new TextDecoder();

  /**
   * Feed the next chunk of the stream and return every frame that completed
   * within it. Returns an empty array when the chunk only advances a partial
   * frame.
   *
   * @param chunk text, or raw UTF-8 bytes, as received off the wire.
   */
  write(chunk: string | Uint8Array): RawSseEvent[] {
    this.buffer +=
      typeof chunk === "string"
        ? chunk
        : this.decoder.decode(chunk, { stream: true });

    const events: RawSseEvent[] = [];
    let lineStart = 0;
    let i = 0;

    while (i < this.buffer.length) {
      const ch = this.buffer[i];

      if (ch === "\n") {
        this.consumeLine(this.buffer.slice(lineStart, i), events);
        i += 1;
        lineStart = i;
      } else if (ch === "\r") {
        // A trailing "\r" at the very end of the buffer is ambiguous: the "\n"
        // of a "\r\n" pair may arrive in the next chunk. Leave it buffered.
        if (i + 1 >= this.buffer.length) break;
        this.consumeLine(this.buffer.slice(lineStart, i), events);
        i += this.buffer[i + 1] === "\n" ? 2 : 1;
        lineStart = i;
      } else {
        i += 1;
      }
    }

    // Retain the unterminated remainder (partial field, or a dangling "\r").
    this.buffer = this.buffer.slice(lineStart);
    return events;
  }

  /** Process one complete wire line (line terminator already stripped). */
  private consumeLine(line: string, out: RawSseEvent[]): void {
    // Blank line -> dispatch whatever frame has accumulated.
    if (line === "") {
      this.dispatch(out);
      return;
    }

    // Comment line -> ignore entirely.
    if (line.startsWith(":")) return;

    const colon = line.indexOf(":");
    const field = colon === -1 ? line : line.slice(0, colon);
    let value = colon === -1 ? "" : line.slice(colon + 1);
    // Strip exactly one leading space after the colon, per the SSE spec.
    if (value.startsWith(" ")) value = value.slice(1);

    switch (field) {
      case "event":
        this.eventName = value;
        break;
      case "data":
        this.dataLines.push(value);
        this.hasData = true;
        break;
      case "id":
        this.id = value;
        break;
      default:
        // Unknown fields (e.g. `retry`) are not part of a RawSseEvent.
        break;
    }
  }

  /** Emit the accumulated frame (if it carried data) and reset frame state. */
  private dispatch(out: RawSseEvent[]): void {
    // A blank line with no `data:` field (e.g. after a comment, or a bare
    // `id:`) dispatches nothing, matching the SSE dispatch algorithm.
    if (this.hasData) {
      const event: RawSseEvent = { data: this.dataLines.join("\n") };
      if (this.eventName !== undefined) event.event = this.eventName;
      if (this.id !== undefined) event.id = this.id;
      out.push(event);
    }

    this.dataLines = [];
    this.hasData = false;
    this.eventName = undefined;
    this.id = undefined;
  }
}

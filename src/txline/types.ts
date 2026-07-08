/**
 * Foundational contract types for the TxLINE odds-feed ingestion pipeline.
 *
 * These are the stable interfaces every downstream slice builds on:
 *   - the SSE wire parser produces {@link RawSseEvent}s,
 *   - the normalizer maps them into {@link NormalizedMatchEvent}s,
 *   - the emitter delivers those via a {@link Sink}.
 *
 * No networking or runtime behaviour lives here — pure type contracts only.
 */

/**
 * A single odds quotation, expressed as a decimal price (e.g. `1.9`).
 */
export type OddsValue = number;

/**
 * The odds carried by one side of a normalized event — "one or many" values.
 *
 * The TxLINE feed sometimes quotes a single price for a market and sometimes a
 * set of prices keyed by outcome/selection (e.g. `{ home, draw, away }`). This
 * union captures both shapes without forcing callers to guess:
 *   - a bare {@link OddsValue} when the feed quotes exactly one price, or
 *   - a `Record<string, OddsValue>` keyed by selection when it quotes several.
 */
export type OddsValues = OddsValue | Record<string, OddsValue>;

/**
 * A normalized match/odds signal emitted to downstream consumers.
 *
 * `timestamp` is the event time in Unix epoch milliseconds (UTC).
 */
export interface NormalizedMatchEvent {
  /** The kind of signal, e.g. `"odds_update"` or `"match_start"`. */
  eventType: string;
  /** Stable identifier of the match this signal refers to. */
  matchId: string;
  /** Odds observed before the change this event represents. */
  oddsBefore: OddsValues;
  /** Odds observed after the change this event represents. */
  oddsAfter: OddsValues;
  /** Event time in Unix epoch milliseconds (UTC). */
  timestamp: number;
}

/**
 * A raw event parsed from the SSE wire format, before normalization.
 *
 * Mirrors the SSE frame fields: an optional `event` name, the (possibly
 * multi-line, already-joined) `data` payload, and an optional `id` used to
 * resume a stream via `Last-Event-ID`.
 */
export interface RawSseEvent {
  /** The SSE `event:` field, when present. */
  event?: string;
  /** The SSE `data:` payload (multi-line data joined with `\n`). */
  data: string;
  /** The SSE `id:` field, used for `Last-Event-ID` resume, when present. */
  id?: string;
}

/**
 * Cancels an active push-subscription.
 */
export interface Subscription {
  /** Detach the listener; subsequent pushes are not delivered to it. */
  unsubscribe(): void;
}

/**
 * A pluggable emitter that fans out pushed items to consumers.
 *
 * Supports two independent consumption paths over the same stream:
 *   - push-subscribe via {@link Sink.subscribe} (synchronous callback), and
 *   - pull-consume via `for await...of` (the inherited async iterator).
 */
export interface Sink<T> extends AsyncIterable<T> {
  /** Deliver `item` to every current subscriber and async consumer. */
  push(item: T): void;
  /** Register a callback invoked for each subsequently pushed item. */
  subscribe(listener: (item: T) => void): Subscription;
}

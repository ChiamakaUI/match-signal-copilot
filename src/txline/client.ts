/**
 * Persistent SSE connection client for the TxLINE odds feed.
 *
 * The client opens an authenticated Server-Sent-Events connection to the feed,
 * streams the received bytes through the {@link SseParser}, and hands each
 * completed {@link RawSseEvent} to the injected `onEvent` handler (which a later
 * slice wires to the normalizer + sink). It owns the two reliability concerns
 * the parser deliberately does not:
 *
 *   - **Resume.** It tracks the `id` of the last event it received and, on every
 *     reconnect, sends it back as the `Last-Event-ID` request header so the feed
 *     resumes where it left off (no missed events across a drop).
 *   - **Reconnect with backoff.** A dropped or errored connection is retried
 *     with exponential backoff capped at a ceiling, so a flapping feed does not
 *     become a reconnect storm.
 *
 * Everything that touches the outside world is injected — the connection
 * `factory` and the `sleep` clock — so the reconnect/backoff/resume behaviour is
 * unit-testable without any real network or wall-clock delay.
 */

import type { Logger } from "../logger.js";
import type { TxlineConfig } from "./config.js";
import { SseParser } from "./sse-parser.js";
import type { RawSseEvent } from "./types.js";

/** A request the client asks the connection factory to open. */
export interface ConnectRequest {
  /** The feed URL to connect to. */
  readonly url: string;
  /**
   * Request headers, including `Authorization` and — on a reconnect — the
   * `Last-Event-ID` resume header.
   */
  readonly headers: Record<string, string>;
}

/** An open connection: an async stream of raw wire chunks. */
export interface SseConnection {
  /**
   * The bytes/text received from the feed, in order. The stream *ending*
   * (iterator completing) is treated as a dropped connection; a thrown error is
   * treated as an errored connection. Either way the client reconnects.
   */
  readonly chunks: AsyncIterable<string | Uint8Array>;
}

/** Opens a connection for a request. May be sync or async; injected in tests. */
export type ConnectionFactory = (
  req: ConnectRequest,
) => SseConnection | Promise<SseConnection>;

/** Exponential-backoff tuning for reconnects. */
export interface BackoffOptions {
  /** Delay before the first reconnect, in ms (must be > 0). */
  readonly baseMs: number;
  /** Upper bound on any single reconnect delay, in ms. */
  readonly capMs: number;
  /** Growth factor between attempts. Defaults to 2. */
  readonly factor?: number;
}

/** Everything the client is composed from (all outside effects injected). */
export interface TxlineClientDeps {
  readonly config: TxlineConfig;
  /** Opens a connection; injected so tests never touch the network. */
  readonly connect: ConnectionFactory;
  /** Invoked for every parsed event. */
  readonly onEvent: (event: RawSseEvent) => void;
  /** Structured logger; reconnects/failures are logged here. */
  readonly logger: Logger;
  /** Delay helper; injected so tests use a fake clock, not real timers. */
  readonly sleep: (ms: number) => Promise<void>;
  /** Backoff tuning; sensible production defaults when omitted. */
  readonly backoff?: BackoffOptions;
}

/** A running client handle. */
export interface TxlineClient {
  /**
   * Run the connect/consume/reconnect loop until {@link TxlineClient.stop} is
   * called. Resolves once the loop has exited.
   */
  start(): Promise<void>;
  /** Request the loop to stop; it exits at the next safe point. */
  stop(): void;
}

/** Production backoff defaults: 1s base, doubling, capped at 30s. */
const DEFAULT_BASE_MS = 1000;
const DEFAULT_CAP_MS = 30000;
const DEFAULT_FACTOR = 2;

/**
 * Create a TxLINE SSE client. Nothing connects until {@link TxlineClient.start}
 * is called.
 */
export function createTxlineClient(deps: TxlineClientDeps): TxlineClient {
  const { config, connect, onEvent, logger, sleep } = deps;
  const baseMs = deps.backoff?.baseMs ?? DEFAULT_BASE_MS;
  const capMs = deps.backoff?.capMs ?? DEFAULT_CAP_MS;
  const factor = deps.backoff?.factor ?? DEFAULT_FACTOR;

  let stopped = false;
  /** The id of the most recent event received across ALL connections so far. */
  let lastEventId: string | undefined;
  /** Consecutive failed/empty attempts; drives the backoff and resets on data. */
  let attempt = 0;

  /** Delay for the current `attempt`: min(cap, base * factor^attempt). */
  function backoffDelay(): number {
    return Math.min(capMs, baseMs * factor ** attempt);
  }

  /** Headers for a fresh connection, including resume + auth. */
  function buildHeaders(): Record<string, string> {
    const headers: Record<string, string> = {
      Accept: "text/event-stream",
      Authorization: `Bearer ${config.authToken}`,
    };
    // Only present once we have actually received an id — the very first
    // connection must NOT carry a Last-Event-ID.
    if (lastEventId !== undefined) headers["Last-Event-ID"] = lastEventId;
    return headers;
  }

  /**
   * Open one connection and drain it. Returns the number of events received so
   * the caller can reset the backoff after a productive connection.
   */
  async function consumeOnce(): Promise<number> {
    const conn = await connect({ url: config.sseUrl, headers: buildHeaders() });
    const parser = new SseParser();
    let received = 0;

    for await (const chunk of conn.chunks) {
      for (const event of parser.write(chunk)) {
        if (event.id !== undefined) lastEventId = event.id;
        received += 1;
        onEvent(event);
      }
      if (stopped) break;
    }

    return received;
  }

  async function start(): Promise<void> {
    while (!stopped) {
      try {
        const received = await consumeOnce();
        // A connection that delivered events was healthy: reset the backoff so
        // the next transient drop starts from the base delay again.
        if (received > 0) attempt = 0;
        logger.info("txline connection closed; will reconnect", {
          attempt,
          lastEventId,
          received,
        });
      } catch (error) {
        // Fail loud: record WHICH step failed and WHY so the reconnect is
        // diagnosable, never a silently swallowed error.
        logger.warn("txline connection failed; will reconnect", {
          attempt,
          error: error instanceof Error ? error.message : String(error),
        });
      }

      if (stopped) break;

      const delay = backoffDelay();
      attempt += 1;
      await sleep(delay);
    }
  }

  return {
    start,
    stop(): void {
      stopped = true;
    },
  };
}

/**
 * End-to-end composition root for the TxLINE odds-feed ingestion service.
 *
 * {@link startTxlineIngestion} is the single top-level entrypoint the rest of
 * the service calls to begin receiving normalized match signals. It wires the
 * REAL production pipeline:
 *
 *   env config -> SSE client (owns reconnect/backoff/resume) -> SSE wire parser
 *     -> normalizer (parse/validate/map, skip-and-log malformed) -> sink
 *
 * The client already embeds the {@link SseParser} and hands each
 * {@link RawSseEvent} to its `onEvent` handler; here that handler IS the real
 * {@link createNormalizer}, which pushes {@link NormalizedMatchEvent}s to the
 * caller's {@link Sink}. Nothing in the pipeline is stubbed.
 *
 * Only the two things that touch the outside world are injectable — so the
 * whole pipeline is testable end-to-end without a network or real timers:
 *   - `connect`: opens the SSE connection. Defaults to a real `fetch`-based
 *     connection; injected in tests to drive a scripted byte stream.
 *   - `sleep`: the reconnect-backoff clock. Defaults to real `setTimeout`.
 *
 * `config` and `logger` also default to their production values
 * ({@link loadTxlineConfig} reading `process.env`, and a structured stdout
 * {@link createLogger}) but may be supplied for tests.
 */

import { createLogger, type Logger } from "../logger.js";
import {
  createTxlineClient,
  type BackoffOptions,
  type ConnectionFactory,
  type ConnectRequest,
  type SseConnection,
} from "./client.js";
import { loadTxlineConfig, type TxlineConfig } from "./config.js";
import { createNormalizer } from "./normalizer.js";
import type { NormalizedMatchEvent, Sink } from "./types.js";

/** Optional, injectable dependencies for {@link startTxlineIngestion}. */
export interface TxlineIngestionDeps {
  /** Feed config; defaults to {@link loadTxlineConfig} (reads `process.env`). */
  readonly config?: TxlineConfig;
  /** Structured logger; defaults to a stdout JSON logger at `info`. */
  readonly logger?: Logger;
  /**
   * Opens the SSE connection (the network boundary). Defaults to a real
   * `fetch`-based connection; injected in tests to drive scripted bytes.
   */
  readonly connect?: ConnectionFactory;
  /** Reconnect-backoff clock; defaults to real `setTimeout`. */
  readonly sleep?: (ms: number) => Promise<void>;
  /** Backoff tuning; the client's production defaults apply when omitted. */
  readonly backoff?: BackoffOptions;
}

/** A running ingestion handle. */
export interface TxlineIngestion {
  /**
   * The running connect/consume/reconnect loop. Resolves once the loop has
   * exited (after {@link TxlineIngestion.stop}).
   */
  readonly done: Promise<void>;
  /** Request ingestion to stop; the loop exits at the next safe point. */
  stop(): void;
}

/** Real `setTimeout`-backed delay used when no `sleep` is injected. */
function realSleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Production SSE connection factory: opens an authenticated `fetch` stream and
 * exposes its response body as the client's chunk stream. This is the real
 * external boundary — the ONE thing tests replace.
 */
export async function fetchConnect(
  req: ConnectRequest,
): Promise<SseConnection> {
  const response = await fetch(req.url, { headers: req.headers });
  if (!response.ok) {
    throw new Error(
      `txline connect: feed returned HTTP ${response.status} ${response.statusText}`,
    );
  }
  if (response.body === null) {
    throw new Error("txline connect: feed response had no body to stream");
  }
  // A `fetch` body is a web ReadableStream, which is async-iterable in Node 20+.
  return { chunks: response.body as AsyncIterable<Uint8Array> };
}

/**
 * Wire and START the end-to-end TxLINE ingestion pipeline, delivering every
 * normalized match signal to `sink`. Returns immediately with a handle whose
 * `done` promise resolves when the loop stops.
 */
export function startTxlineIngestion(
  sink: Sink<NormalizedMatchEvent>,
  deps: TxlineIngestionDeps = {},
): TxlineIngestion {
  const config = deps.config ?? loadTxlineConfig();
  const logger = deps.logger ?? createLogger({ level: "info" });
  const connect = deps.connect ?? fetchConnect;
  const sleep = deps.sleep ?? realSleep;

  // REAL normalizer wired to the caller's sink — this is the client's onEvent.
  const normalizer = createNormalizer({ sink, logger });

  // REAL client (which itself constructs the REAL SseParser internally).
  const client = createTxlineClient({
    config,
    connect,
    logger,
    sleep,
    backoff: deps.backoff,
    onEvent: normalizer,
  });

  // Kick off the loop now; expose its completion promise as `done`.
  const done = client.start();

  return {
    done,
    stop(): void {
      client.stop();
    },
  };
}

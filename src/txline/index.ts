/**
 * Public entrypoint for the TxLINE odds-feed ingestion service.
 *
 * Downstream consumers import from here to start ingestion and to reference the
 * normalized signal contract they will receive:
 *
 * ```ts
 * import { startTxlineIngestion, EventEmitterSink } from "./txline/index.js";
 * import type { NormalizedMatchEvent } from "./txline/index.js";
 *
 * const sink = new EventEmitterSink<NormalizedMatchEvent>();
 * sink.subscribe((signal) => { ... });
 * const ingestion = startTxlineIngestion(sink);
 * // later: ingestion.stop(); await ingestion.done;
 * ```
 *
 * This module re-exports the composition root ({@link startTxlineIngestion}),
 * the in-memory sink, and the shared contract types so consumers depend on one
 * stable surface rather than reaching into individual pipeline modules.
 */

export {
  startTxlineIngestion,
  fetchConnect,
  type TxlineIngestion,
  type TxlineIngestionDeps,
} from "./service.js";
export { EventEmitterSink } from "./sink.js";
export { loadTxlineConfig, type TxlineConfig } from "./config.js";
export type {
  NormalizedMatchEvent,
  OddsValue,
  OddsValues,
  RawSseEvent,
  Sink,
  Subscription,
} from "./types.js";

/**
 * Normalizer for the TxLINE odds feed.
 *
 * Takes a {@link RawSseEvent} (as produced by the SSE wire parser), parses its
 * `data` payload as a TxLINE match event, and maps it to a
 * {@link NormalizedMatchEvent}, pushing the result to the injected {@link Sink}.
 *
 * This is first-party core, so it fails SOFT on bad input rather than throwing:
 * a malformed or partial payload (invalid JSON, wrong top-level shape, or a
 * missing / wrong-typed required field) is logged at warn level and SKIPPED, so
 * one bad frame never halts processing of the frames that follow it.
 *
 * The logger is injected (the structured {@link import("../logger.js").Logger}
 * satisfies {@link NormalizerLogger}, or any minimal `warn`-capable object) so
 * skips are observable downstream.
 */

import type {
  NormalizedMatchEvent,
  OddsValues,
  RawSseEvent,
  Sink,
} from "./types.js";

/** The minimal logger surface the normalizer needs: warn-level skips only. */
export interface NormalizerLogger {
  warn(msg: string, fields?: Record<string, unknown>): void;
}

/** Injected collaborators for {@link createNormalizer}. */
export interface NormalizerDeps {
  /** Destination for successfully normalized records. */
  sink: Sink<NormalizedMatchEvent>;
  /** Structured logger used to record (and thus surface) skipped payloads. */
  logger: NormalizerLogger;
}

/** Consumes one raw SSE event, normalizing-and-emitting or skipping-and-logging. */
export type Normalizer = (raw: RawSseEvent) => void;

/**
 * The on-the-wire shape of a TxLINE match event, carried in the SSE `data`
 * payload as JSON. Every field is required; the normalizer rejects a payload
 * that omits any of them or carries a wrong-typed value.
 */
const WARN_MSG = "txline.normalize: skipping malformed match event payload";

/** True when `v` is a valid odds quantity: a finite number, or a non-empty
 *  record whose every value is a finite number (the "one or many" union). */
function isOddsValues(v: unknown): v is OddsValues {
  if (typeof v === "number") return Number.isFinite(v);
  if (typeof v === "object" && v !== null && !Array.isArray(v)) {
    const values = Object.values(v as Record<string, unknown>);
    return (
      values.length > 0 &&
      values.every((x) => typeof x === "number" && Number.isFinite(x))
    );
  }
  return false;
}

function isNonEmptyString(v: unknown): v is string {
  return typeof v === "string" && v.length > 0;
}

/**
 * Build a {@link Normalizer} bound to a sink and logger. The returned function
 * never throws for bad input — it warns and returns.
 */
export function createNormalizer(deps: NormalizerDeps): Normalizer {
  const { sink, logger } = deps;

  return (raw: RawSseEvent): void => {
    const idFields = raw.id !== undefined ? { id: raw.id } : {};

    let parsed: unknown;
    try {
      parsed = JSON.parse(raw.data);
    } catch (err) {
      logger.warn(WARN_MSG, {
        reason: "invalid_json",
        error: err instanceof Error ? err.message : String(err),
        ...idFields,
      });
      return;
    }

    if (
      typeof parsed !== "object" ||
      parsed === null ||
      Array.isArray(parsed)
    ) {
      logger.warn(WARN_MSG, { reason: "not_an_object", ...idFields });
      return;
    }

    const p = parsed as Record<string, unknown>;

    // Collect EVERY invalid/missing field so the log names all of them at once.
    const invalid: string[] = [];
    if (!isNonEmptyString(p.eventType)) invalid.push("eventType");
    if (!isNonEmptyString(p.matchId)) invalid.push("matchId");
    if (!isOddsValues(p.oddsBefore)) invalid.push("oddsBefore");
    if (!isOddsValues(p.oddsAfter)) invalid.push("oddsAfter");
    if (typeof p.timestamp !== "number" || !Number.isFinite(p.timestamp)) {
      invalid.push("timestamp");
    }

    if (invalid.length > 0) {
      logger.warn(WARN_MSG, {
        reason: "missing_or_invalid_fields",
        fields: invalid,
        ...idFields,
      });
      return;
    }

    // Construct explicitly (not a spread) so unknown wire fields are dropped and
    // each normalized field is mapped from exactly its named source field.
    const normalized: NormalizedMatchEvent = {
      eventType: p.eventType as string,
      matchId: p.matchId as string,
      oddsBefore: p.oddsBefore as OddsValues,
      oddsAfter: p.oddsAfter as OddsValues,
      timestamp: p.timestamp as number,
    };
    sink.push(normalized);
  };
}

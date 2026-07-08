/**
 * TxLINE-scoped, environment-based configuration.
 *
 * This is intentionally SEPARATE from the general {@link ../config.ts} app
 * config (owned by another roadmap item): it holds only the settings the TxLINE
 * SSE odds-feed client needs, so the two modules never overlap.
 *
 * The loader is FAIL-FAST. A missing `TXLINE_SSE_URL` throws at load time rather
 * than connecting to some baked-in placeholder endpoint, and a missing
 * `TXLINE_AUTH_TOKEN` throws rather than silently opening an unauthenticated
 * connection to the feed. No insecure/placeholder default is ever assumed.
 */

/** The fully-resolved, validated TxLINE feed configuration. */
export interface TxlineConfig {
  /** Absolute URL of the TxLINE SSE odds-feed endpoint. */
  readonly sseUrl: string;
  /** Bearer token presented to the feed on every connection. */
  readonly authToken: string;
}

/**
 * Load TxLINE configuration from the given environment (defaults to
 * `process.env`). Accepting the env as a parameter keeps the loader pure and
 * testable; the production composition root calls `loadTxlineConfig()`.
 *
 * @throws if `TXLINE_SSE_URL` or `TXLINE_AUTH_TOKEN` is absent or blank — there
 * is deliberately NO default endpoint or token.
 */
export function loadTxlineConfig(
  env: NodeJS.ProcessEnv = process.env,
): TxlineConfig {
  const sseUrl = env.TXLINE_SSE_URL?.trim();
  if (!sseUrl) {
    throw new Error(
      "Missing required TXLINE_SSE_URL: set it to the TxLINE SSE odds-feed " +
        "endpoint. There is no default endpoint.",
    );
  }

  const authToken = env.TXLINE_AUTH_TOKEN?.trim();
  if (!authToken) {
    throw new Error(
      "Missing required TXLINE_AUTH_TOKEN: set it to the TxLINE feed auth " +
        "token. The client will not connect unauthenticated.",
    );
  }

  return { sseUrl, authToken };
}

/**
 * Health-check HTTP entrypoint for match-signal-copilot.
 *
 * Exposes a single public, unauthenticated `GET /health` endpoint returning
 * `200 {"status":"ok"}` — the first demo-able proof the service boots. The
 * server is wired to the real {@link AppConfig} (for its bind port) and the
 * structured {@link Logger} (for the startup line); nothing here reads
 * `process.env` directly. The future odds-signal ingestion pipeline builds on
 * this reachable liveness endpoint.
 */

import http from "node:http";
import type { AddressInfo } from "node:net";

import type { AppConfig } from "./config.js";
import type { Logger } from "./logger.js";

/** Dependencies the server is composed from (injected by the entrypoint). */
export interface ServerDeps {
  config: AppConfig;
  logger: Logger;
}

/** Handle to a listening server, with the actually-bound port and a closer. */
export interface RunningServer {
  server: http.Server;
  /** The port the OS actually bound (equals `config.port` for a fixed port). */
  port: number;
  /** Gracefully stop accepting connections and resolve when fully closed. */
  close(): Promise<void>;
}

/** Static liveness payload — a constant this service emits, not sourced data. */
const HEALTH_BODY = JSON.stringify({ status: "ok" });

/**
 * Build (but do not start) the health-check HTTP server. Kept separate from
 * {@link startServer} so the request handler can be unit-tested without binding
 * a socket.
 */
export function createHealthServer(): http.Server {
  return http.createServer((req, res) => {
    if (req.method === "GET" && req.url === "/health") {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(HEALTH_BODY);
      return;
    }
    res.writeHead(404, { "content-type": "application/json" });
    res.end(JSON.stringify({ error: "not found" }));
  });
}

/**
 * Start the health-check server bound to `deps.config.port`, logging a
 * structured "listening" line via `deps.logger` once the socket is open.
 *
 * Rejects if the port cannot be bound (e.g. already in use) so startup fails
 * loudly rather than leaving a half-initialized server.
 */
export function startServer(deps: ServerDeps): Promise<RunningServer> {
  const { config, logger } = deps;
  const server = createHealthServer();

  return new Promise<RunningServer>((resolve, reject) => {
    const onError = (err: Error): void => reject(err);
    server.once("error", onError);

    server.listen(config.port, () => {
      server.removeListener("error", onError);
      const address = server.address() as AddressInfo | null;
      const port = address ? address.port : config.port;

      logger.info(`listening on port ${port}`, { port });

      resolve({
        server,
        port,
        close: () =>
          new Promise<void>((res, rej) => {
            server.close((err) => (err ? rej(err) : res()));
          }),
      });
    });
  });
}

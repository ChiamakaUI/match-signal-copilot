import { test } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import net from "node:net";

import { loadConfig } from "../src/config.ts";
import { createLogger } from "../src/logger.ts";
import { startServer, type RunningServer } from "../src/server.ts";
import { main } from "../src/index.ts";

/** Bind an OS-assigned free port, then release it so a test can reuse it. */
function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const probe = net.createServer();
    probe.once("error", reject);
    probe.listen(0, () => {
      const addr = probe.address();
      const port = typeof addr === "object" && addr ? addr.port : 0;
      probe.close(() => resolve(port));
    });
  });
}

interface HttpResult {
  status: number;
  body: string;
}

/** Minimal GET against localhost:port and collect the full body. */
function httpGet(port: number, path: string): Promise<HttpResult> {
  return new Promise((resolve, reject) => {
    const req = http.request(
      { host: "127.0.0.1", port, path, method: "GET" },
      (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (c: Buffer) => chunks.push(c));
        res.on("end", () =>
          resolve({
            status: res.statusCode ?? 0,
            body: Buffer.concat(chunks).toString("utf8"),
          }),
        );
      },
    );
    req.once("error", reject);
    req.end();
  });
}

/**
 * Capture the REAL production default sink (process.stdout.write) while `fn`
 * runs, so the startup-log assertion exercises the composition root, not a fake.
 */
async function captureStdout(fn: () => Promise<void>): Promise<string[]> {
  const original = process.stdout.write.bind(process.stdout);
  const chunks: string[] = [];
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  process.stdout.write = ((chunk: any): boolean => {
    chunks.push(String(chunk));
    return true;
  }) as typeof process.stdout.write;
  try {
    await fn();
  } finally {
    process.stdout.write = original;
  }
  return chunks
    .join("")
    .split("\n")
    .filter((l) => l.length > 0);
}

test("server::health_ok -> GET /health returns 200 with JSON body {status:'ok'}", async () => {
  const port = await freePort();
  const config = loadConfig({ PORT: String(port) });
  const logger = createLogger({ level: config.logLevel, write: () => {} });
  let running: RunningServer | undefined;
  try {
    running = await startServer({ config, logger });
    const res = await httpGet(running.port, "/health");
    assert.equal(res.status, 200, `expected 200, got ${res.status}`);
    // A stub returning a bare 200 with no/`{}` body goes RED here: the parsed
    // body must actually carry status === "ok".
    const parsed = JSON.parse(res.body) as Record<string, unknown>;
    assert.equal(
      parsed.status,
      "ok",
      `body.status must equal "ok", got ${JSON.stringify(parsed)}`,
    );
  } finally {
    await running?.close();
  }
});

test("server::health_uses_config_port -> binds to config.port, not a hardcoded literal", async () => {
  // Use a random OS-assigned port set via env → config. A hardcoded `3000`
  // impl would leave this port unbound, so connecting to it would be refused.
  const port = await freePort();
  const config = loadConfig({ PORT: String(port) });
  assert.notEqual(port, 3000, "test port must differ from the default 3000");
  const logger = createLogger({ level: config.logLevel, write: () => {} });
  let running: RunningServer | undefined;
  try {
    running = await startServer({ config, logger });
    assert.equal(
      running.port,
      port,
      `server must listen on config.port ${port}, got ${running.port}`,
    );
    const res = await httpGet(port, "/health");
    assert.equal(
      res.status,
      200,
      `server must be reachable on config.port ${port}, got status ${res.status}`,
    );
  } finally {
    await running?.close();
  }
});

test("server::health_startup_log -> emits a JSON 'listening' line carrying the configured port", async () => {
  const port = await freePort();
  const config = loadConfig({ PORT: String(port) });
  // Real logger with the REAL default stdout sink (no write override), captured.
  const logger = createLogger({ level: config.logLevel });
  let running: RunningServer | undefined;
  const lines = await captureStdout(async () => {
    running = await startServer({ config, logger });
  });
  try {
    const listening = lines
      .map((l) => {
        try {
          return JSON.parse(l) as Record<string, unknown>;
        } catch {
          return undefined;
        }
      })
      .find((o) => o !== undefined && String(o.msg).includes("listening"));
    assert.ok(
      listening,
      `expected a JSON log line whose msg mentions "listening"; got lines: ${JSON.stringify(lines)}`,
    );
    assert.equal(
      listening.level,
      "info",
      `listening line must be level=info, got ${String(listening.level)}`,
    );
    // The port must be the CONFIGURED port carried as a structured field, not a
    // hardcoded literal — a `3000` impl would put 3000 here and go RED.
    assert.equal(
      listening.port,
      port,
      `listening line must carry the configured port ${port}, got ${String(listening.port)}`,
    );
  } finally {
    await running?.close();
  }
});

test("server::health_e2e -> production entrypoint wiring boots and serves /health", async () => {
  // Boot through the REAL production composition root (main() → loadConfig +
  // createLogger + startServer), driven only by the environment.
  const port = await freePort();
  const savedPort = process.env.PORT;
  const savedLevel = process.env.LOG_LEVEL;
  process.env.PORT = String(port);
  // Keep the e2e run quiet without bypassing the real logger construction.
  process.env.LOG_LEVEL = "error";
  let running: RunningServer | undefined;
  try {
    running = await main();
    assert.equal(
      running.port,
      port,
      `entrypoint must bind config.port ${port}, got ${running.port}`,
    );
    const res = await httpGet(running.port, "/health");
    assert.equal(res.status, 200, `e2e expected 200, got ${res.status}`);
    const parsed = JSON.parse(res.body) as Record<string, unknown>;
    assert.equal(
      parsed.status,
      "ok",
      `e2e body.status must equal "ok", got ${JSON.stringify(parsed)}`,
    );
  } finally {
    await running?.close();
    if (savedPort === undefined) delete process.env.PORT;
    else process.env.PORT = savedPort;
    if (savedLevel === undefined) delete process.env.LOG_LEVEL;
    else process.env.LOG_LEVEL = savedLevel;
  }
});

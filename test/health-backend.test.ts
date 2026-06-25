import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Server } from "node:http";
import { PgliteBackend } from "../src/pglite-backend.js";
import { createApp } from "../src/app.js";
import { loadConfig } from "../src/config.js";
import type { Ports } from "../src/ports/types.js";

let dir: string;
let db: PgliteBackend;
let server: Server | undefined;
let baseUrl: string;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "hyper-mcp-health-"));
  db = new PgliteBackend(dir);
});

afterEach(async () => {
  if (server) await new Promise<void>(r => server!.close(() => r()));
  if (db) await db.close().catch(() => undefined);
  if (dir) await rm(dir, { recursive: true, force: true }).catch(() => undefined);
});

function startApp(backend: string) {
  // /health is public and does not initialize the backend, so an unknown
  // backend string is safe here and proves the value comes from config.
  const config = loadConfig({
    HYPER_MCP_BACKEND: backend,
    HYPER_MCP_TRUST_MODE: "hosted",
    HYPER_MCP_AUTH_REQUIRED: "true",
  } as any);
  const getPorts = (): Promise<Ports> => Promise.resolve(db);
  const app = createApp(config, getPorts);
  return new Promise<void>((resolve) => {
    server = app.listen(0, "127.0.0.1", () => {
      baseUrl = `http://127.0.0.1:${(server!.address() as any).port}`;
      resolve();
    });
  });
}

describe("/health and scoutos://ports report config.backend", () => {
  it("/health uses config.backend, not a hardcoded string", async () => {
    await startApp("custom-test-backend");
    const res = await fetch(`${baseUrl}/health`, { headers: { accept: "application/json" } });
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.backend).toBe("custom-test-backend");
  });

  it("/health reports pglite when that is the configured backend", async () => {
    await startApp("pglite");
    const res = await fetch(`${baseUrl}/health`, { headers: { accept: "application/json" } });
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.backend).toBe("pglite");
  });
});
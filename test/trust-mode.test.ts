import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { generateKeyPair, SignJWT, exportJWK } from "jose";
import type { Server } from "node:http";
import { PgliteBackend } from "../src/pglite-backend.js";
import { createApp } from "../src/app.js";
import { loadConfig, assertStdioConfig } from "../src/config.js";
import type { Config } from "../src/config.js";
import type { Ports } from "../src/ports/types.js";

let dir: string;
let db: PgliteBackend;
let adminJwk: any;
let server: Server | undefined;
let baseUrl: string;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "hyper-mcp-trust-"));
  db = new PgliteBackend(dir);
  const adminPair = await generateKeyPair("Ed25519", { extractable: true });
  adminJwk = { ...(await exportJWK(adminPair.publicKey)), kid: "admin-1" };
});

afterEach(async () => {
  if (server) await new Promise<void>(r => server!.close(() => r()));
  if (db) await db.close().catch(() => undefined);
  if (dir) await rm(dir, { recursive: true, force: true }).catch(() => undefined);
});

function startApp(config: Config) {
  const getPorts = (): Promise<Ports> => Promise.resolve(db);
  const app = createApp(config, getPorts);
  return new Promise<void>((resolve) => {
    server = app.listen(0, "127.0.0.1", () => {
      const addr = server!.address() as any;
      baseUrl = `http://127.0.0.1:${addr.port}`;
      resolve();
    });
  });
}

function hostedConfig(): Config {
  return loadConfig({
    HYPER_MCP_ADMIN_PUBLIC_JWK: JSON.stringify(adminJwk),
    HYPER_MCP_ADMIN_ISSUER: "admin-agent",
    HYPER_MCP_ADMIN_AUDIENCE: "hyper-mcp",
    HYPER_MCP_ADMIN_KID: "admin-1",
    HYPER_MCP_AUTH_REQUIRED: "true",
    HYPER_MCP_TRUST_MODE: "hosted",
  } as any);
}

function localConfig(): Config {
  return loadConfig({
    HYPER_MCP_AUTH_REQUIRED: "false",
    HYPER_MCP_TRUST_MODE: "local",
  } as any);
}

async function postJson(path: string, body: unknown, token?: string) {
  return fetch(`${baseUrl}${path}`, {
    method: "POST",
    headers: {
      accept: "application/json, text/event-stream",
      "content-type": "application/json",
      ...(token ? { authorization: `Bearer ${token}` } : {}),
    },
    body: JSON.stringify(body),
  });
}

describe("trust mode inference", () => {
  it("infers hosted when authRequired and no explicit trust mode", () => {
    const cfg = loadConfig({ HYPER_MCP_AUTH_REQUIRED: "true" } as any);
    expect(cfg.trustMode).toBe("hosted");
    expect(cfg.trustModeInferred).toBe(true);
  });

  it("infers local when authRequired is false and no explicit trust mode", () => {
    const cfg = loadConfig({ HYPER_MCP_AUTH_REQUIRED: "false" } as any);
    expect(cfg.trustMode).toBe("local");
    expect(cfg.trustModeInferred).toBe(true);
  });

  it("respects an explicit trust mode and clears the inferred flag", () => {
    const cfg = loadConfig({ HYPER_MCP_TRUST_MODE: "local", HYPER_MCP_AUTH_REQUIRED: "true" } as any);
    expect(cfg.trustMode).toBe("local");
    expect(cfg.trustModeInferred).toBe(false);
  });
});

describe("stdio startup guard", () => {
  it("refuses to start in hosted mode without an admin trust root", () => {
    const cfg = loadConfig({ HYPER_MCP_TRUST_MODE: "hosted", HYPER_MCP_AUTH_REQUIRED: "true" } as any);
    expect(() => assertStdioConfig(cfg)).toThrow(/hosted trust mode without an admin trust root/);
  });

  it("allows hosted mode with an admin trust root", () => {
    const cfg = hostedConfig();
    expect(() => assertStdioConfig(cfg)).not.toThrow();
  });

  it("allows local mode without an admin trust root", () => {
    const cfg = localConfig();
    expect(() => assertStdioConfig(cfg)).not.toThrow();
  });
});

describe("hosted trust mode fails closed", () => {
  it("returns 503 when admin trust root is missing (no tool executes as default)", async () => {
    const cfg = loadConfig({ HYPER_MCP_TRUST_MODE: "hosted", HYPER_MCP_AUTH_REQUIRED: "true" } as any);
    await startApp(cfg);
    const res = await postJson("/mcp", { jsonrpc: "2.0", method: "tools/list", id: 1 });
    expect(res.status).toBe(503);
  });

  it("returns 401 with admin configured but no auth context (no token)", async () => {
    await startApp(hostedConfig());
    const res = await postJson("/mcp", { jsonrpc: "2.0", method: "tools/list", id: 1 });
    expect(res.status).toBe(401);
  });
});

describe("local trust mode runs as default account", () => {
  it("accepts /mcp tools/list without a token", async () => {
    await startApp(localConfig());
    const res = await postJson("/mcp", { jsonrpc: "2.0", method: "tools/list", id: 1 });
    expect(res.status).toBe(200);
    const text = await res.text();
    expect(text).toMatch(/tools|result|event:/);
  });

  it("executes a write tool without a token and stores data under the default account", async () => {
    await startApp(localConfig());
    const res = await postJson("/mcp", {
      jsonrpc: "2.0", id: 2, method: "tools/call",
      params: { name: "data_create", arguments: { collection: "local-c", document: { hello: "world" } } },
    });
    expect(res.status).toBe(200);

    // The document must be visible to the default account (accountId undefined).
    const count = await db.dataCount(undefined, "local-c");
    expect(count.count).toBe(1);
  });
});
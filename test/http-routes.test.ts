import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { generateKeyPair, SignJWT, exportJWK } from "jose";
import type { Server } from "node:http";
import { PgliteBackend } from "../src/pglite-backend.js";
import { createApp } from "../src/app.js";
import { loadConfig } from "../src/config.js";
import type { Config } from "../src/config.js";
import type { Ports } from "../src/ports/types.js";

let dir: string;
let db: PgliteBackend;
let adminPrivate: any;
let adminJwk: any;
let accountPrivate: any;
let accountJwk: any;
let server: Server | undefined;
let baseUrl: string;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "hyper-mcp-http-"));
  db = new PgliteBackend(dir);

  const adminPair = await generateKeyPair("Ed25519", { extractable: true });
  adminPrivate = adminPair.privateKey;
  adminJwk = { ...(await exportJWK(adminPair.publicKey)), kid: "admin-1" };

  const accountPair = await generateKeyPair("Ed25519", { extractable: true });
  accountPrivate = accountPair.privateKey;
  accountJwk = { ...(await exportJWK(accountPair.publicKey)), kid: "acc-1" };
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
  } as any);
}

async function signAdminJwt() {
  return new SignJWT({ scope: "accounts:admin" })
    .setProtectedHeader({ alg: "EdDSA", kid: "admin-1" })
    .setIssuer("admin-agent")
    .setAudience("hyper-mcp")
    .setExpirationTime("1h")
    .sign(adminPrivate);
}

async function signAccountJwt(issuer = "agent-tom") {
  return new SignJWT({})
    .setProtectedHeader({ alg: "EdDSA", kid: "acc-1" })
    .setIssuer(issuer)
    .setAudience("hyper-mcp")
    .setExpirationTime("1h")
    .sign(accountPrivate);
}

async function get(path: string) {
  return fetch(`${baseUrl}${path}`, { headers: { accept: "application/json" } });
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

describe("HTTP public routes", () => {
  it("GET / returns the landing page", async () => {
    await startApp(hostedConfig());
    const res = await get("/");
    expect(res.status).toBe(200);
    const text = await res.text();
    expect(text).toContain("hyper-mcp");
  });

  it("GET /health returns ok with auth/admin flags", async () => {
    await startApp(hostedConfig());
    const res = await get("/health");
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.ok).toBe(true);
    expect(json.service).toBe("hyper-mcp");
    expect(json.authRequired).toBe(true);
    expect(json.adminConfigured).toBe(true);
  });
});

describe("HTTP /mcp auth gateway", () => {
  it("rejects POST /mcp without a token with 401", async () => {
    await startApp(hostedConfig());
    const res = await postJson("/mcp", { jsonrpc: "2.0", method: "tools/list", id: 1 });
    expect(res.status).toBe(401);
    const json = await res.json();
    expect(json.error?.message).toMatch(/AUTH|MISSING|FAILED/);
  });

  it("returns 503 when admin trust root is missing (auth required, no admin)", async () => {
    const cfg = loadConfig({ HYPER_MCP_AUTH_REQUIRED: "true" } as any);
    await startApp(cfg);
    const res = await postJson("/mcp", { jsonrpc: "2.0", method: "tools/list", id: 1 });
    expect(res.status).toBe(503);
    const json = await res.json();
    expect(json.error?.message).toBe("ADMIN_NOT_CONFIGURED");
  });

  it("accepts tools/list with a valid account JWT and responds", async () => {
    await startApp(hostedConfig());
    // Register the account via the admin-protected /register endpoint.
    const reg = await postJson("/register", {
      accountId: "agent-tom",
      name: "Tom's agent",
      issuer: "agent-tom",
      audience: "hyper-mcp",
      publicJwk: accountJwk,
      ports: { "data:read": true, "data:write": true },
    }, await signAdminJwt());
    expect(reg.status).toBe(201);

    const token = await signAccountJwt("agent-tom");
    const res = await postJson("/mcp", { jsonrpc: "2.0", method: "tools/list", id: 2 }, token);
    expect(res.status).toBe(200);
    const text = await res.text();
    expect(text).toMatch(/tools|result|event:/);
  });

  it("rejects a disabled account JWT with 401", async () => {
    await startApp(hostedConfig());
    await postJson("/register", {
      accountId: "agent-tom",
      name: "Tom's agent",
      issuer: "agent-tom",
      audience: "hyper-mcp",
      publicJwk: accountJwk,
      ports: { "data:read": true },
    }, await signAdminJwt());

    // Disable the account directly via the backend.
    await db.accountDisable("agent-tom");

    const token = await signAccountJwt("agent-tom");
    const res = await postJson("/mcp", { jsonrpc: "2.0", method: "tools/list", id: 3 }, token);
    expect(res.status).toBe(401);
  });
});

describe("HTTP /register admin protection", () => {
  it("returns 503 when admin trust root is not configured", async () => {
    const cfg = loadConfig({ HYPER_MCP_AUTH_REQUIRED: "true" } as any);
    await startApp(cfg);
    const res = await postJson("/register", {
      accountId: "x", issuer: "x", audience: "hyper-mcp",
      publicJwk: accountJwk, ports: { "data:read": true },
    }, "not-a-real-admin-jwt");
    expect(res.status).toBe(503);
  });

  it("returns 201 with a valid admin JWT", async () => {
    await startApp(hostedConfig());
    const res = await postJson("/register", {
      accountId: "agent-tom",
      name: "Tom's agent",
      issuer: "agent-tom",
      audience: "hyper-mcp",
      publicJwk: accountJwk,
      ports: { "data:read": true, "data:write": true },
    }, await signAdminJwt());
    expect(res.status).toBe(201);
    const json = await res.json();
    expect(json.ok).toBe(true);
    expect(json.accountId).toBe("agent-tom");
    expect(json.status).toBe("active");
    expect(json.scopes).toEqual(["data:read", "data:write"]);
  });

  it("returns 403 for a non-admin (wrong-scope) JWT", async () => {
    await startApp(hostedConfig());
    // Sign a JWT with the admin key but without accounts:admin scope.
    const nonAdmin = await new SignJWT({ scope: "data:read" })
      .setProtectedHeader({ alg: "EdDSA", kid: "admin-1" })
      .setIssuer("admin-agent")
      .setAudience("hyper-mcp")
      .setExpirationTime("1h")
      .sign(adminPrivate);
    const res = await postJson("/register", {
      accountId: "x", issuer: "x", audience: "hyper-mcp",
      publicJwk: accountJwk, ports: { "data:read": true },
    }, nonAdmin);
    expect(res.status).toBe(403);
  });

  it("returns 401 for an expired admin JWT", async () => {
    await startApp(hostedConfig());
    const expired = await new SignJWT({ scope: "accounts:admin" })
      .setProtectedHeader({ alg: "EdDSA", kid: "admin-1" })
      .setIssuer("admin-agent")
      .setAudience("hyper-mcp")
      .setExpirationTime("-1s")
      .sign(adminPrivate);
    const res = await postJson("/register", {
      accountId: "x", issuer: "x", audience: "hyper-mcp",
      publicJwk: accountJwk, ports: { "data:read": true },
    }, expired);
    expect(res.status).toBe(401);
  });

  it("returns 400 when neither publicJwk nor jwksUrl is provided", async () => {
    await startApp(hostedConfig());
    const res = await postJson("/register", {
      accountId: "x", issuer: "x", audience: "hyper-mcp",
      ports: { "data:read": true },
    }, await signAdminJwt());
    expect(res.status).toBe(400);
  });
});

describe("HTTP /unregister", () => {
  it("returns 400 without confirm: true", async () => {
    await startApp(hostedConfig());
    await postJson("/register", {
      accountId: "agent-tom", issuer: "agent-tom", audience: "hyper-mcp",
      publicJwk: accountJwk, ports: { "data:read": true },
    }, await signAdminJwt());

    const res = await postJson("/unregister", { accountId: "agent-tom" }, await signAdminJwt());
    expect(res.status).toBe(400);
  });

  it("returns 404 for an unknown account", async () => {
    await startApp(hostedConfig());
    const res = await postJson("/unregister", { accountId: "ghost", confirm: true }, await signAdminJwt());
    expect(res.status).toBe(404);
  });

  it("returns 200 and disables a valid account", async () => {
    await startApp(hostedConfig());
    await postJson("/register", {
      accountId: "agent-tom", issuer: "agent-tom", audience: "hyper-mcp",
      publicJwk: accountJwk, ports: { "data:read": true },
    }, await signAdminJwt());

    const res = await postJson("/unregister", { accountId: "agent-tom", confirm: true }, await signAdminJwt());
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.ok).toBe(true);
    expect(json.status).toBe("disabled");

    // Account is now disabled: issuer lookup returns null.
    expect(await db.accountGetByIssuer("agent-tom")).toBeNull();
  });
});

describe("HTTP MCP scope enforcement", () => {
  it("a read-only account calling a write tool gets a FORBIDDEN tool error", async () => {
    await startApp(hostedConfig());
    await postJson("/register", {
      accountId: "ro-agent", issuer: "ro-agent", audience: "hyper-mcp",
      publicJwk: accountJwk, ports: { "data:read": true, "data:write": false },
    }, await signAdminJwt());

    const token = await signAccountJwt("ro-agent");
    const res = await postJson("/mcp", {
      jsonrpc: "2.0", id: 4, method: "tools/call",
      params: { name: "data_create", arguments: { collection: "c", document: { x: 1 } } },
    }, token);

    // Scope failures are caught by the tool handler and returned as an MCP
    // error result (isError) carrying the FORBIDDEN code + status 403, not as
    // an HTTP 403. The gateway already authorized the JWT; the tool refused.
    expect(res.status).toBe(200);
    const text = await res.text();
    expect(text).toContain("FORBIDDEN");
    expect(text).toContain("403");
  });
});
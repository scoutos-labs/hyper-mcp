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
let accountJwk: any;
let server: Server | undefined;
let baseUrl: string;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "hyper-mcp-posture-"));
  db = new PgliteBackend(dir);
  const adminPair = await generateKeyPair("Ed25519", { extractable: true });
  adminPrivate = adminPair.privateKey;
  adminJwk = { ...(await exportJWK(adminPair.publicKey)), kid: "admin-1" };
  const accountPair = await generateKeyPair("Ed25519", { extractable: true });
  accountJwk = { ...(await exportJWK(accountPair.publicKey)), kid: "acc-1" };
});

afterEach(async () => {
  if (server) await new Promise<void>(r => server!.close(() => r()));
  if (db) await db.close().catch(() => undefined);
  if (dir) await rm(dir, { recursive: true, force: true }).catch(() => undefined);
});

function startApp(opts: { metricsPublic?: boolean; readOnly?: boolean } = {}) {
  const config = loadConfig({
    HYPER_MCP_ADMIN_PUBLIC_JWK: JSON.stringify(adminJwk),
    HYPER_MCP_ADMIN_ISSUER: "admin-agent",
    HYPER_MCP_ADMIN_AUDIENCE: "hyper-mcp",
    HYPER_MCP_ADMIN_KID: "admin-1",
    HYPER_MCP_AUTH_REQUIRED: "true",
    HYPER_MCP_TRUST_MODE: "hosted",
    HYPER_MCP_METRICS_PUBLIC: opts.metricsPublic === false ? "false" : "true",
    HYPER_MCP_READONLY: opts.readOnly ? "true" : "false",
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

async function signAdminJwt() {
  return new SignJWT({ scope: "accounts:admin" })
    .setProtectedHeader({ alg: "EdDSA", kid: "admin-1" })
    .setIssuer("admin-agent")
    .setAudience("hyper-mcp")
    .setExpirationTime("1h")
    .sign(adminPrivate);
}

async function get(path: string, token?: string) {
  return fetch(`${baseUrl}${path}`, {
    headers: { accept: "application/json", ...(token ? { authorization: `Bearer ${token}` } : {}) },
  });
}

async function postJson(path: string, body: unknown, token?: string) {
  return fetch(`${baseUrl}${path}`, {
    method: "POST",
    headers: {
      accept: "application/json",
      "content-type": "application/json",
      ...(token ? { authorization: `Bearer ${token}` } : {}),
    },
    body: JSON.stringify(body),
  });
}

const registerBody = {
  accountId: "agent-tom", issuer: "agent-tom", audience: "hyper-mcp",
  publicJwk: {} as any, ports: { "data:read": true },
};

describe("/metrics posture", () => {
  it("is public by default (no token required)", async () => {
    await startApp();
    const res = await get("/metrics");
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(typeof json.requests).toBe("number");
  });

  it("requires an admin JWT when HYPER_MCP_METRICS_PUBLIC=false", async () => {
    await startApp({ metricsPublic: false });
    const noToken = await get("/metrics");
    expect(noToken.status).toBe(401);

    const withAdmin = await get("/metrics", await signAdminJwt());
    expect(withAdmin.status).toBe(200);
    const json = await withAdmin.json();
    expect(typeof json.requests).toBe("number");
  });
});

describe("read-only posture blocks admin mutations", () => {
  it("blocks /register with 403 READ_ONLY_ADMIN_BLOCKED", async () => {
    await startApp({ readOnly: true });
    registerBody.publicJwk = accountJwk;
    const res = await postJson("/register", registerBody, await signAdminJwt());
    expect(res.status).toBe(403);
    const json = await res.json();
    expect(json.error).toBe("READ_ONLY_ADMIN_BLOCKED");
    // No account row created.
    expect(await db.accountGet("agent-tom")).toBeNull();
  });

  it("blocks /unregister with 403 READ_ONLY_ADMIN_BLOCKED", async () => {
    await startApp({ readOnly: false });
    registerBody.publicJwk = accountJwk;
    await postJson("/register", registerBody, await signAdminJwt());

    // Restart in read-only mode against the same backend.
    await new Promise<void>(r => server!.close(() => r()));
    server = undefined;
    await startApp({ readOnly: true });

    const res = await postJson("/unregister", { accountId: "agent-tom", confirm: true }, await signAdminJwt());
    expect(res.status).toBe(403);
    const json = await res.json();
    expect(json.error).toBe("READ_ONLY_ADMIN_BLOCKED");
    // Account still active.
    const acc = await db.accountGet("agent-tom");
    expect(acc?.status).toBe("active");
  });

  it("still allows /register when not read-only", async () => {
    await startApp({ readOnly: false });
    registerBody.publicJwk = accountJwk;
    const res = await postJson("/register", registerBody, await signAdminJwt());
    expect(res.status).toBe(201);
  });
});
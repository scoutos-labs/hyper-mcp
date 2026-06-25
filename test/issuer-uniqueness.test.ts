import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { generateKeyPair, SignJWT, exportJWK } from "jose";
import type { Server } from "node:http";
import { PgliteBackend } from "../src/pglite-backend.js";
import { PortError } from "../src/errors.js";
import { createApp } from "../src/app.js";
import { loadConfig } from "../src/config.js";
import type { Ports } from "../src/ports/types.js";

let dir: string;
let db: PgliteBackend;
let adminPrivate: any;
let adminJwk: any;
let accountJwk: any;
let server: Server | undefined;
let baseUrl: string;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "hyper-mcp-issuer-"));
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

function startHostedApp() {
  const config = loadConfig({
    HYPER_MCP_ADMIN_PUBLIC_JWK: JSON.stringify(adminJwk),
    HYPER_MCP_ADMIN_ISSUER: "admin-agent",
    HYPER_MCP_ADMIN_AUDIENCE: "hyper-mcp",
    HYPER_MCP_ADMIN_KID: "admin-1",
    HYPER_MCP_AUTH_REQUIRED: "true",
    HYPER_MCP_TRUST_MODE: "hosted",
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

async function register(accountId: string, issuer: string, token?: string) {
  return fetch(`${baseUrl}/register`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      ...(token ? { authorization: `Bearer ${token}` } : {}),
    },
    body: JSON.stringify({
      accountId,
      issuer,
      audience: "hyper-mcp",
      publicJwk: accountJwk,
      ports: { "data:read": true },
    }),
  });
}

describe("account issuer uniqueness (backend)", () => {
  it("rejects a second active account with the same issuer (409)", async () => {
    await db.accountCreate("agent-a", "A", "shared-issuer", "hyper-mcp", ["data:read"]);
    await expect(
      db.accountCreate("agent-b", "B", "shared-issuer", "hyper-mcp", ["data:read"]),
    ).rejects.toMatchObject({ code: "ISSUER_CONFLICT", status: 409 });

    // The second account must not have been created.
    expect(await db.accountGet("agent-b")).toBeNull();
  });

  it("does not block different issuers", async () => {
    await db.accountCreate("agent-a", "A", "issuer-a", "hyper-mcp", ["data:read"]);
    await expect(
      db.accountCreate("agent-b", "B", "issuer-b", "hyper-mcp", ["data:read"]),
    ).resolves.toMatchObject({ ok: true, accountId: "agent-b" });
  });

  it("allows re-registering the same accountId with the same issuer", async () => {
    await db.accountCreate("agent-a", "A", "issuer-a", "hyper-mcp", ["data:read"]);
    // Updating the same account (e.g. refreshing scopes) must not conflict.
    await expect(
      db.accountCreate("agent-a", "A2", "issuer-a", "hyper-mcp", ["data:read", "data:write"]),
    ).resolves.toMatchObject({ ok: true, accountId: "agent-a" });
  });

  it("frees the issuer for reuse after the account is disabled", async () => {
    await db.accountCreate("agent-a", "A", "reusable-issuer", "hyper-mcp", ["data:read"]);
    await db.accountDisable("agent-a");

    // Disabled account no longer holds the active issuer.
    expect(await db.accountGetByIssuer("reusable-issuer")).toBeNull();

    // A new account can now take the same issuer.
    await expect(
      db.accountCreate("agent-b", "B", "reusable-issuer", "hyper-mcp", ["data:read"]),
    ).resolves.toMatchObject({ ok: true, accountId: "agent-b" });
  });

  it("rejects re-enabling a disabled account whose issuer now collides", async () => {
    await db.accountCreate("agent-a", "A", "collide-issuer", "hyper-mcp", ["data:read"]);
    await db.accountDisable("agent-a");
    // Reuse the issuer while agent-a is disabled.
    await db.accountCreate("agent-b", "B", "collide-issuer", "hyper-mcp", ["data:read"]);

    // Re-enabling agent-a (same accountId) with the now-taken issuer must fail.
    await expect(
      db.accountCreate("agent-a", "A", "collide-issuer", "hyper-mcp", ["data:read"]),
    ).rejects.toMatchObject({ code: "ISSUER_CONFLICT", status: 409 });
  });
});

describe("account issuer uniqueness (HTTP /register)", () => {
  it("returns 409 and writes an audit log for a duplicate active issuer", async () => {
    await startHostedApp();
    const admin = await signAdminJwt();

    const first = await register("agent-a", "shared-issuer", admin);
    expect(first.status).toBe(201);

    const second = await register("agent-b", "shared-issuer", admin);
    expect(second.status).toBe(409);
    const json = await second.json();
    expect(json.error).toBe("ISSUER_CONFLICT");

    // The failed attempt must be audited.
    const logs = await db.auditLogQuery("agent-b");
    const failure = logs.find((l: any) => l.outcome === "failure" && l.action === "register");
    expect(failure).toBeDefined();
  });
});
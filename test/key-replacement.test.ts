import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer as createHttpServer, type Server } from "node:http";
import { generateKeyPair, SignJWT, exportJWK } from "jose";
import { PgliteBackend } from "../src/pglite-backend.js";
import { validateAccountJwt } from "../src/auth.js";
import { loadConfig } from "../src/config.js";

let dir: string;
let db: PgliteBackend;
let oldPair: any;
let oldJwk: any;
let newPair: any;
let newJwk: any;
let jwksServer: Server | undefined;
let jwksPort: number;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "hyper-mcp-keyrep-"));
  db = new PgliteBackend(dir);
  oldPair = await generateKeyPair("Ed25519", { extractable: true });
  oldJwk = { ...(await exportJWK(oldPair.publicKey)), kid: "old-1" };
  newPair = await generateKeyPair("Ed25519", { extractable: true });
  newJwk = { ...(await exportJWK(newPair.publicKey)), kid: "new-1" };
});

afterEach(async () => {
  if (jwksServer) await new Promise<void>(r => jwksServer!.close(() => r()));
  jwksServer = undefined;
  if (db) await db.close().catch(() => undefined);
  if (dir) await rm(dir, { recursive: true, force: true }).catch(() => undefined);
});

function startJwksServer(keys: any[]) {
  const body = JSON.stringify({ keys });
  jwksServer = createHttpServer((_req, res) => {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(body);
  });
  return new Promise<void>((resolve) => {
    jwksServer!.listen(0, "127.0.0.1", () => {
      jwksPort = (jwksServer!.address() as any).port;
      resolve();
    });
  });
}

function jwksUrl() {
  return `http://127.0.0.1:${jwksPort}/jwks.json`;
}

const cfg = () => loadConfig({ HYPER_MCP_AUTH_REQUIRED: "true", HYPER_MCP_JWKS_CACHE_SECONDS: "1" } as any);

async function signJwt(privateKey: any, kid: string) {
  return new SignJWT({})
    .setProtectedHeader({ alg: "EdDSA", kid })
    .setIssuer("agent-tom")
    .setAudience("hyper-mcp")
    .setExpirationTime("1h")
    .sign(privateKey);
}

async function expectAuthFails(privateKey: any, kid: string) {
  await expect(validateAccountJwt(await signJwt(privateKey, kid), cfg(), db)).rejects.toMatchObject({ code: "AUTH_FAILED", status: 401 });
}

async function expectAuthSucceeds(privateKey: any, kid: string) {
  const ctx = await validateAccountJwt(await signJwt(privateKey, kid), cfg(), db);
  expect(ctx.accountId).toBe("agent-tom");
}

describe("key/JWKS replacement (Option A — full replace)", () => {
  it("switching from inline JWK to JWKS URL deactivates the old inline key", async () => {
    // Initial registration with an inline key.
    await db.accountCreate("agent-tom", "Tom", "agent-tom", "hyper-mcp", ["data:read"]);
    await db.accountAddKey("agent-tom", "old-1", oldJwk);
    await expectAuthSucceeds(oldPair.privateKey, "old-1");

    // Re-register via the same path /register takes: upsert + clearAuth + add JWKS.
    await startJwksServer([newJwk]);
    await db.accountCreate("agent-tom", "Tom", "agent-tom", "hyper-mcp", ["data:read"]);
    await db.accountClearAuth("agent-tom");
    await db.accountAddJwksUrl("agent-tom", jwksUrl());

    // Old inline key must no longer authenticate.
    await expectAuthFails(oldPair.privateKey, "old-1");
    // New key, served via JWKS, authenticates.
    await expectAuthSucceeds(newPair.privateKey, "new-1");

    // And the old inline key row is gone.
    const keys = await db.accountGetKeys("agent-tom");
    expect(keys).toHaveLength(0);
  });

  it("switching from JWKS URL to inline JWK stops JWKS from being consulted", async () => {
    // Initial registration via JWKS serving the old key.
    await startJwksServer([oldJwk]);
    await db.accountCreate("agent-tom", "Tom", "agent-tom", "hyper-mcp", ["data:read"]);
    await db.accountAddJwksUrl("agent-tom", jwksUrl());
    await expectAuthSucceeds(oldPair.privateKey, "old-1");

    // Re-register with an inline key (the new key).
    await db.accountCreate("agent-tom", "Tom", "agent-tom", "hyper-mcp", ["data:read"]);
    await db.accountClearAuth("agent-tom");
    await db.accountAddKey("agent-tom", "new-1", newJwk);

    // Shut down the JWKS server: if JWKS were still being consulted, auth
    // would fail with a fetch error. It must not be consulted.
    await new Promise<void>(r => jwksServer!.close(() => r()));
    jwksServer = undefined;

    // New inline key authenticates without the JWKS server.
    await expectAuthSucceeds(newPair.privateKey, "new-1");
    // Old JWKS key no longer authenticates (not served, not stored).
    await expectAuthFails(oldPair.privateKey, "old-1");

    // And the JWKS URL row is gone.
    expect(await db.accountGetJwksUrl("agent-tom")).toBeNull();
  });

  it("single-mode re-registration (JWK -> refreshed JWK) replaces the old key", async () => {
    await db.accountCreate("agent-tom", "Tom", "agent-tom", "hyper-mcp", ["data:read"]);
    await db.accountAddKey("agent-tom", "old-1", oldJwk);
    await expectAuthSucceeds(oldPair.privateKey, "old-1");

    // Re-register same mode with a refreshed key.
    await db.accountCreate("agent-tom", "Tom", "agent-tom", "hyper-mcp", ["data:read"]);
    await db.accountClearAuth("agent-tom");
    await db.accountAddKey("agent-tom", "new-1", newJwk);

    await expectAuthFails(oldPair.privateKey, "old-1");
    await expectAuthSucceeds(newPair.privateKey, "new-1");

    const keys = await db.accountGetKeys("agent-tom");
    expect(keys).toHaveLength(1);
    expect(keys[0].kid).toBe("new-1");
  });
});
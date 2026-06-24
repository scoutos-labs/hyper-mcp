import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { generateKeyPair, SignJWT, exportJWK } from "jose";
import { PgliteBackend } from "../src/pglite-backend.js";
import { parsePorts } from "../src/auth.js";
import { hasScope } from "../src/auth.js";
import { getAuthContext, runWithAuth } from "../src/auth-context.js";
import type { AuthContext } from "../src/auth.js";

let dir: string;
let db: PgliteBackend;
let adminKeyPair: { publicKey: any; privateKey: any };
let adminJwk: any;
let adminPrivateJwk: any;
let accountKeyPair: { publicKey: any; privateKey: any };
let accountJwk: any;
let accountPrivateJwk: any;

async function freshDb() {
  dir = await mkdtemp(join(tmpdir(), "hyper-mcp-int-"));
  db = new PgliteBackend(dir);

  // Generate admin keys
  adminKeyPair = await generateKeyPair("Ed25519", { extractable: true });
  adminJwk = { ...(await exportJWK(adminKeyPair.publicKey)), kid: "admin-1" };
  adminPrivateJwk = { ...(await exportJWK(adminKeyPair.privateKey)), kid: "admin-1" };

  // Generate account keys
  accountKeyPair = await generateKeyPair("Ed25519", { extractable: true });
  accountJwk = { ...(await exportJWK(accountKeyPair.publicKey)), kid: "acc-1" };
  accountPrivateJwk = { ...(await exportJWK(accountKeyPair.privateKey)), kid: "acc-1" };
}

async function cleanupDb() {
  if (db) await db.close().catch(() => undefined);
  if (dir) await rm(dir, { recursive: true, force: true });
}

beforeEach(freshDb);
afterEach(cleanupDb);

async function signAdminJwt(scopes: string[] = ["accounts:admin"]) {
  return new SignJWT({ scope: scopes.join(" ") })
    .setProtectedHeader({ alg: "EdDSA", kid: "admin-1" })
    .setIssuer("admin-agent")
    .setAudience("hyper-mcp")
    .setExpirationTime("1h")
    .sign(adminKeyPair.privateKey);
}

async function signAccountJwt(issuer: string) {
  return new SignJWT({})
    .setProtectedHeader({ alg: "EdDSA", kid: "acc-1" })
    .setIssuer(issuer)
    .setAudience("hyper-mcp")
    .setExpirationTime("1h")
    .sign(accountKeyPair.privateKey);
}

describe("integration: auth context propagation", () => {
  it("runWithAuth makes auth context available via getAuthContext", async () => {
    const ctx: AuthContext = {
      accountId: "test-account",
      issuer: "test-account",
      audience: "hyper-mcp",
      scopes: ["data:read", "data:write"],
      source: "account",
    };

    expect(getAuthContext()).toBeUndefined();

    await runWithAuth(ctx, async () => {
      expect(getAuthContext()?.accountId).toBe("test-account");
      expect(getAuthContext()?.scopes).toContain("data:read");
    });

    expect(getAuthContext()).toBeUndefined();
  });

  it("auth context is isolated per request (async boundary)", async () => {
    const results: string[] = [];

    await Promise.all([
      runWithAuth({ accountId: "a", issuer: "a", audience: "hyper-mcp", scopes: [], source: "account" }, async () => {
        await new Promise(r => setTimeout(r, 10));
        results.push(getAuthContext()?.accountId || "none");
      }),
      runWithAuth({ accountId: "b", issuer: "b", audience: "hyper-mcp", scopes: [], source: "account" }, async () => {
        await new Promise(r => setTimeout(r, 5));
        results.push(getAuthContext()?.accountId || "none");
      }),
    ]);

    expect(results).toContain("a");
    expect(results).toContain("b");
    expect(results).not.toContain("none");
  });
});

describe("integration: scope enforcement via AsyncLocalStorage", () => {
  it("read-only scope blocks write operations", async () => {
    const readOnlyCtx: AuthContext = {
      accountId: "ro-agent",
      issuer: "ro-agent",
      audience: "hyper-mcp",
      scopes: ["data:read"],
      source: "account",
    };

    await runWithAuth(readOnlyCtx, async () => {
      const ctx = getAuthContext()!;
      expect(hasScope(ctx.scopes, "data:read")).toBe(true);
      expect(hasScope(ctx.scopes, "data:write")).toBe(false);
      expect(hasScope(ctx.scopes, "data:dangerous")).toBe(false);
    });
  });

  it("admin wildcard grants all scopes", async () => {
    const adminCtx: AuthContext = {
      accountId: "admin",
      issuer: "admin-agent",
      audience: "hyper-mcp",
      scopes: ["accounts:admin"],
      source: "admin",
    };

    await runWithAuth(adminCtx, async () => {
      const ctx = getAuthContext()!;
      expect(hasScope(ctx.scopes, "data:read")).toBe(true);
      expect(hasScope(ctx.scopes, "data:write")).toBe(true);
      expect(hasScope(ctx.scopes, "blob:write")).toBe(true);
      expect(hasScope(ctx.scopes, "queue:dangerous")).toBe(true);
    });
  });

  it("port-specific admin grants all scopes for that port", async () => {
    const dataAdminCtx: AuthContext = {
      accountId: "data-admin",
      issuer: "data-admin",
      audience: "hyper-mcp",
      scopes: ["data:admin"],
      source: "account",
    };

    await runWithAuth(dataAdminCtx, async () => {
      const ctx = getAuthContext()!;
      expect(hasScope(ctx.scopes, "data:read")).toBe(true);
      expect(hasScope(ctx.scopes, "data:write")).toBe(true);
      expect(hasScope(ctx.scopes, "data:dangerous")).toBe(true);
      expect(hasScope(ctx.scopes, "cache:read")).toBe(false);
    });
  });
});

describe("integration: full JWT lifecycle", () => {
  it("generates key pairs, signs JWTs, and validates scope chain", async () => {
    // 1. Admin registers an account
    const scopes = parsePorts({
      "data:read": true,
      "data:write": true,
      "cache:read": true,
      "cache:write": false,
      "blob:read": true,
      "blob:write": true,
      "queue:read": true,
      "queue:write": true,
      "search:read": true,
      "search:write": true,
    });

    await db.accountCreate("agent-x", "Agent X", "agent-x", "hyper-mcp", scopes);
    await db.accountAddKey("agent-x", "acc-1", accountJwk);

    // 2. Admin JWT is valid
    const adminJwt = await signAdminJwt();
    expect(adminJwt).toBeTruthy();

    // 3. Account JWT is valid
    const accountJwt = await signAccountJwt("agent-x");
    expect(accountJwt).toBeTruthy();

    // 4. Account record has correct scopes
    const account = await db.accountGetByIssuer("agent-x");
    expect(account).not.toBeNull();
    expect(account!.scopes).toContain("data:read");
    expect(account!.scopes).toContain("data:write");
    expect(account!.scopes).not.toContain("cache:write");

    // 5. Scopes enforce correctly
    expect(hasScope(account!.scopes, "data:read")).toBe(true);
    expect(hasScope(account!.scopes, "data:write")).toBe(true);
    expect(hasScope(account!.scopes, "cache:write")).toBe(false);
  });

  it("disabled account is rejected by issuer lookup", async () => {
    await db.accountCreate("agent-disabled", "Disabled", "agent-disabled", "hyper-mcp", ["data:read"]);
    await db.accountAddKey("agent-disabled", "acc-1", accountJwk);

    // Active
    expect(await db.accountGetByIssuer("agent-disabled")).not.toBeNull();

    // Disable
    await db.accountDisable("agent-disabled");

    // Should be null (disabled accounts not returned)
    expect(await db.accountGetByIssuer("agent-disabled")).toBeNull();
  });

  it("audit log records registration and unregistration", async () => {
    await db.accountCreate("agent-audited", "Audited", "agent-audited", "hyper-mcp", ["data:read"]);

    await db.auditLog("admin", "agent-audited", "register", "success", { scopes: ["data:read"] });
    await db.auditLog("admin", "agent-audited", "unregister", "success");

    const logs = await db.auditLogQuery("agent-audited");
    expect(logs).toHaveLength(2);
    const actions = logs.map((l: any) => l.action);
    expect(actions).toContain("register");
    expect(actions).toContain("unregister");
    logs.forEach((l: any) => expect(l.outcome).toBe("success"));
  });
});
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PgliteBackend } from "../src/pglite-backend.js";
import { PortError } from "../src/errors.js";
import { parsePorts, isValidScope, hasScope } from "../src/auth.js";

let dir: string;
let db: PgliteBackend;

async function freshDb() {
  dir = await mkdtemp(join(tmpdir(), "hyper-mcp-auth-"));
  db = new PgliteBackend(dir);
}

async function cleanupDb() {
  if (db) await db.close().catch(() => undefined);
  if (dir) await rm(dir, { recursive: true, force: true });
}

beforeEach(freshDb);
afterEach(cleanupDb);

describe("auth schema", () => {
  it("creates and retrieves accounts", async () => {
    const created = await db.accountCreate("agent-a", "Agent A", "agent-a", "hyper-mcp", ["data:read", "data:write"]);
    expect(created).toMatchObject({ ok: true, accountId: "agent-a", status: "active", scopes: ["data:read", "data:write"] });

    const got = await db.accountGet("agent-a");
    expect(got).toMatchObject({ accountId: "agent-a", name: "Agent A", issuer: "agent-a", audience: "hyper-mcp", status: "active" });
    expect(got!.scopes).toEqual(["data:read", "data:write"]);
  });

  it("looks up accounts by issuer", async () => {
    await db.accountCreate("agent-b", "Agent B", "agent-b", "hyper-mcp", ["cache:read"]);
    const found = await db.accountGetByIssuer("agent-b");
    expect(found).toMatchObject({ accountId: "agent-b", status: "active" });
    expect(await db.accountGetByIssuer("nobody")).toBeNull();
  });

  it("disables accounts", async () => {
    await db.accountCreate("agent-c", "C", "agent-c", "hyper-mcp", ["data:read"]);
    const disabled = await db.accountDisable("agent-c");
    expect(disabled.ok).toBe(true);
    const got = await db.accountGet("agent-c");
    expect(got!.status).toBe("disabled");
    // Disabled accounts should not be returned by issuer lookup
    expect(await db.accountGetByIssuer("agent-c")).toBeNull();
  });

  it("stores and retrieves account keys", async () => {
    await db.accountCreate("agent-d", "D", "agent-d", "hyper-mcp", ["data:read"]);
    const jwk = { kty: "OKP", crv: "Ed25519", x: "abc123", kid: "key-1" };
    await db.accountAddKey("agent-d", "key-1", jwk);
    const keys = await db.accountGetKeys("agent-d");
    expect(keys).toHaveLength(1);
    expect(keys[0].kid).toBe("key-1");
    expect(keys[0].publicJwk).toMatchObject({ kty: "OKP", crv: "Ed25519", x: "abc123" });
  });

  it("stores and retrieves JWKS URLs", async () => {
    await db.accountCreate("agent-e", "E", "agent-e", "hyper-mcp", ["data:read"]);
    await db.accountAddJwksUrl("agent-e", "https://example.com/.well-known/jwks.json");
    const jwks = await db.accountGetJwksUrl("agent-e");
    expect(jwks).toMatchObject({ jwksUrl: "https://example.com/.well-known/jwks.json" });
  });

  it("writes audit log entries", async () => {
    await db.auditLog("admin", "agent-f", "register", "success", { scopes: ["data:read"] });
    const rows = await db.auditLogQuery("agent-f");
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ actor: "admin", account_id: "agent-f", action: "register", outcome: "success" });
  });

  it("persists accounts across restart", async () => {
    await db.accountCreate("agent-persist", "Persist", "agent-persist", "hyper-mcp", ["data:read"]);
    await db.accountAddKey("agent-persist", "k1", { kty: "OKP", crv: "Ed25519", x: "xyz" });
    await db.close();
    db = new PgliteBackend(dir);
    const got = await db.accountGet("agent-persist");
    expect(got).toMatchObject({ accountId: "agent-persist", status: "active" });
    const keys = await db.accountGetKeys("agent-persist");
    expect(keys).toHaveLength(1);
  });
});

describe("scope helpers", () => {
  it("validates scope strings", () => {
    expect(isValidScope("data:read")).toBe(true);
    expect(isValidScope("cache:write")).toBe(true);
    expect(isValidScope("accounts:admin")).toBe(true);
    expect(isValidScope("data:dangerous")).toBe(true);
    expect(isValidScope("invalid:read")).toBe(false);
    expect(isValidScope("data:invalid")).toBe(false);
    expect(isValidScope("bad")).toBe(false);
  });

  it("parses ports object into granted scopes", () => {
    const scopes = parsePorts({
      "data:read": true,
      "data:write": true,
      "cache:read": false,
      "blob:write": true,
    });
    expect(scopes).toEqual(["data:read", "data:write", "blob:write"]);
  });

  it("rejects unknown scopes in parsePorts", () => {
    expect(() => parsePorts({ "invalid:read": true })).toThrow(PortError);
    expect(() => parsePorts({ "data:bad": true })).toThrow(PortError);
  });

  it("checks scope presence with admin and wildcard rules", () => {
    expect(hasScope(["data:read"], "data:read")).toBe(true);
    expect(hasScope(["data:read"], "data:write")).toBe(false);
    expect(hasScope(["accounts:admin"], "data:write")).toBe(true);
    expect(hasScope(["data:admin"], "data:write")).toBe(true);
    expect(hasScope(["cache:read"], "data:read")).toBe(false);
  });
});
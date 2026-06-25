import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer as createHttpServer, type Server } from "node:http";
import { generateKeyPair, SignJWT, exportJWK, importJWK } from "jose";
import { PgliteBackend } from "../src/pglite-backend.js";
import { validateAdminJwt, validateAccountJwt } from "../src/auth.js";
import { PortError } from "../src/errors.js";
import { loadConfig } from "../src/config.js";

let dir: string;
let db: PgliteBackend;

// Admin keys (reused across admin JWT tests)
let adminPrivate: any;
let adminJwk: any;

// Account keys (reused across account JWT tests)
let accountPrivate: any;
let accountJwk: any;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "hyper-mcp-jwt-"));
  db = new PgliteBackend(dir);

  const adminPair = await generateKeyPair("Ed25519", { extractable: true });
  adminPrivate = adminPair.privateKey;
  adminJwk = { ...(await exportJWK(adminPair.publicKey)), kid: "admin-1" };

  const accountPair = await generateKeyPair("Ed25519", { extractable: true });
  accountPrivate = accountPair.privateKey;
  accountJwk = { ...(await exportJWK(accountPair.publicKey)), kid: "acc-1" };
});

afterEach(async () => {
  if (db) await db.close().catch(() => undefined);
  if (dir) await rm(dir, { recursive: true, force: true }).catch(() => undefined);
});

function adminConfig() {
  return loadConfig({
    HYPER_MCP_ADMIN_PUBLIC_JWK: JSON.stringify(adminJwk),
    HYPER_MCP_ADMIN_ISSUER: "admin-agent",
    HYPER_MCP_ADMIN_AUDIENCE: "hyper-mcp",
    HYPER_MCP_ADMIN_KID: "admin-1",
    HYPER_MCP_AUTH_REQUIRED: "true",
  } as any);
}

function signAdminJwt(opts: {
  scopes?: string[];
  issuer?: string;
  audience?: string;
  expiresIn?: string | number;
  kid?: string;
} = {}) {
  const scopes = opts.scopes ?? ["accounts:admin"];
  return new SignJWT({ scope: scopes.join(" ") })
    .setProtectedHeader({ alg: "EdDSA", kid: opts.kid ?? "admin-1" })
    .setIssuer(opts.issuer ?? "admin-agent")
    .setAudience(opts.audience ?? "hyper-mcp")
    .setExpirationTime(opts.expiresIn ?? "1h")
    .sign(adminPrivate);
}

async function signAccountJwt(opts: {
  issuer?: string;
  audience?: string;
  expiresIn?: string | number;
  kid?: string;
} = {}) {
  return new SignJWT({})
    .setProtectedHeader({ alg: "EdDSA", kid: opts.kid ?? "acc-1" })
    .setIssuer(opts.issuer ?? "agent-tom")
    .setAudience(opts.audience ?? "hyper-mcp")
    .setExpirationTime(opts.expiresIn ?? "1h")
    .sign(accountPrivate);
}

async function registerAccount(issuer = "agent-tom", scopes = ["data:read", "data:write"]) {
  await db.accountCreate("agent-tom", "Tom's agent", issuer, "hyper-mcp", scopes);
  await db.accountAddKey("agent-tom", "acc-1", accountJwk);
}

function expectPortError(p: Promise<unknown>, code: string, status: number) {
  return p.then(
    () => { throw new Error(`expected PortError ${code}, got success`); },
    (e) => {
      expect(e).toBeInstanceOf(PortError);
      expect((e as PortError).code).toBe(code);
      expect((e as PortError).status).toBe(status);
    },
  );
}

describe("validateAdminJwt", () => {
  it("accepts a valid admin JWT with accounts:admin", async () => {
    const ctx = await validateAdminJwt(await signAdminJwt(), adminConfig());
    expect(ctx.source).toBe("admin");
    expect(ctx.scopes).toContain("accounts:admin");
  });

  it("rejects an admin JWT missing accounts:admin with 403", async () => {
    await expectPortError(
      validateAdminJwt(await signAdminJwt({ scopes: ["data:read"] }), adminConfig()),
      "FORBIDDEN",
      403,
    );
  });

  it("rejects an expired admin JWT with 401", async () => {
    await expectPortError(
      validateAdminJwt(await signAdminJwt({ expiresIn: "-1s" }), adminConfig()),
      "AUTH_FAILED",
      401,
    );
  });

  it("rejects a wrong-issuer admin JWT with 401", async () => {
    await expectPortError(
      validateAdminJwt(await signAdminJwt({ issuer: "evil" }), adminConfig()),
      "AUTH_FAILED",
      401,
    );
  });

  it("rejects a wrong-audience admin JWT with 401", async () => {
    await expectPortError(
      validateAdminJwt(await signAdminJwt({ audience: "other-service" }), adminConfig()),
      "AUTH_FAILED",
      401,
    );
  });

  it("rejects an admin JWT with an unknown kid with 401", async () => {
    // Sign with the admin key but claim a kid that is not in the trust root.
    // jwtVerify matches by kid when present; an unknown kid yields no key -> 401.
    await expectPortError(
      validateAdminJwt(await signAdminJwt({ kid: "unknown-kid" }), adminConfig()),
      "AUTH_FAILED",
      401,
    );
  });

  it("returns 503 ADMIN_NOT_CONFIGURED when no admin trust root is set", async () => {
    const noAdmin = loadConfig({ HYPER_MCP_AUTH_REQUIRED: "true" } as any);
    await expectPortError(validateAdminJwt(await signAdminJwt(), noAdmin), "ADMIN_NOT_CONFIGURED", 503);
  });
});

describe("validateAccountJwt", () => {
  it("accepts a valid account JWT and returns DB-stored scopes", async () => {
    await registerAccount("agent-tom", ["data:read", "data:write"]);
    const cfg = loadConfig({ HYPER_MCP_AUTH_REQUIRED: "true" } as any);
    const ctx = await validateAccountJwt(await signAccountJwt(), cfg, db);
    expect(ctx.source).toBe("account");
    expect(ctx.accountId).toBe("agent-tom");
    expect(ctx.scopes).toEqual(["data:read", "data:write"]);
  });

  it("uses scopes from the DB record, not the JWT payload", async () => {
    await registerAccount("agent-tom", ["data:read"]);
    const cfg = loadConfig({ HYPER_MCP_AUTH_REQUIRED: "true" } as any);
    // Put a bogus scope claim in the JWT; it must be ignored.
    const bogus = new SignJWT({ scope: "data:dangerous accounts:admin" })
      .setProtectedHeader({ alg: "EdDSA", kid: "acc-1" })
      .setIssuer("agent-tom")
      .setAudience("hyper-mcp")
      .setExpirationTime("1h")
      .sign(accountPrivate);
    const ctx = await validateAccountJwt(await bogus, cfg, db);
    expect(ctx.scopes).toEqual(["data:read"]);
    expect(ctx.scopes).not.toContain("data:dangerous");
    expect(ctx.scopes).not.toContain("accounts:admin");
  });

  it("rejects a disabled account with 401", async () => {
    await registerAccount("agent-tom", ["data:read"]);
    await db.accountDisable("agent-tom");
    const cfg = loadConfig({ HYPER_MCP_AUTH_REQUIRED: "true" } as any);
    await expectPortError(validateAccountJwt(await signAccountJwt(), cfg, db), "AUTH_FAILED", 401);
  });

  it("rejects a wrong-issuer account JWT with 401", async () => {
    await registerAccount("agent-tom", ["data:read"]);
    const cfg = loadConfig({ HYPER_MCP_AUTH_REQUIRED: "true" } as any);
    await expectPortError(
      validateAccountJwt(await signAccountJwt({ issuer: "someone-else" }), cfg, db),
      "AUTH_FAILED",
      401,
    );
  });

  it("rejects a wrong-audience account JWT with 401", async () => {
    await registerAccount("agent-tom", ["data:read"]);
    const cfg = loadConfig({ HYPER_MCP_AUTH_REQUIRED: "true" } as any);
    await expectPortError(
      validateAccountJwt(await signAccountJwt({ audience: "other-service" }), cfg, db),
      "AUTH_FAILED",
      401,
    );
  });

  it("rejects an expired account JWT with 401", async () => {
    await registerAccount("agent-tom", ["data:read"]);
    const cfg = loadConfig({ HYPER_MCP_AUTH_REQUIRED: "true" } as any);
    await expectPortError(
      validateAccountJwt(await signAccountJwt({ expiresIn: "-1s" }), cfg, db),
      "AUTH_FAILED",
      401,
    );
  });

  it("authenticates via a registered JWKS URL", async () => {
    // Serve the account public key as a JWKS document over a real HTTP server.
    const jwks = JSON.stringify({ keys: [accountJwk] });
    const jwksServer: Server = createHttpServer((_req, res) => {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(jwks);
    });
    await new Promise<void>(r => jwksServer.listen(0, "127.0.0.1", r));
    const jwksPort = (jwksServer.address() as any).port;
    const jwksUrl = `http://127.0.0.1:${jwksPort}/jwks.json`;

    try {
      await db.accountCreate("agent-jwks", "JWKS agent", "agent-jwks", "hyper-mcp", ["cache:read"]);
      await db.accountAddJwksUrl("agent-jwks", jwksUrl);

      const cfg = loadConfig({ HYPER_MCP_AUTH_REQUIRED: "true", HYPER_MCP_JWKS_CACHE_SECONDS: "1" } as any);
      const token = await new SignJWT({})
        .setProtectedHeader({ alg: "EdDSA", kid: "acc-1" })
        .setIssuer("agent-jwks")
        .setAudience("hyper-mcp")
        .setExpirationTime("1h")
        .sign(accountPrivate);

      const ctx = await validateAccountJwt(token, cfg, db);
      expect(ctx.accountId).toBe("agent-jwks");
      expect(ctx.scopes).toEqual(["cache:read"]);
    } finally {
      await new Promise<void>(r => jwksServer.close(() => r()));
    }
  });
});
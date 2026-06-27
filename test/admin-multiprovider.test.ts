import { beforeEach, describe, expect, it } from "vitest";
import { createServer as createHttpServer, type Server } from "node:http";
import { generateKeyPair, SignJWT, exportJWK } from "jose";
import { loadConfig, assertStdioConfig } from "../src/config.js";
import { validateAdminJwt } from "../src/auth.js";
import { PortError } from "../src/errors.js";

// Two admin keypairs so we can test issuer-routed verification across providers.
let providerAPrivate: any;
let providerAJwk: any;
let providerBPrivate: any;
let providerBJwk: any;

beforeEach(async () => {
  const a = await generateKeyPair("Ed25519", { extractable: true });
  providerAPrivate = a.privateKey;
  providerAJwk = { ...(await exportJWK(a.publicKey)), kid: "admin-a" };

  const b = await generateKeyPair("Ed25519", { extractable: true });
  providerBPrivate = b.privateKey;
  providerBJwk = { ...(await exportJWK(b.publicKey)), kid: "admin-b" };
});

function signAdmin(opts: {
  key: any;
  issuer: string;
  audience?: string;
  scopes?: string[];
  kid?: string;
  expiresIn?: string | number;
} = { key: null, issuer: "" }) {
  const scopes = opts.scopes ?? ["accounts:admin"];
  return new SignJWT({ scope: scopes.join(" ") })
    .setProtectedHeader({ alg: "EdDSA", kid: opts.kid ?? "admin-a" })
    .setIssuer(opts.issuer)
    .setAudience(opts.audience ?? "hyper-mcp")
    .setExpirationTime(opts.expiresIn ?? "1h")
    .sign(opts.key);
}

async function expectPortError(p: Promise<unknown>, code: string, status: number) {
  await p.then(
    () => { throw new Error(`expected PortError ${code}, got success`); },
    (e) => {
      expect(e).toBeInstanceOf(PortError);
      expect((e as PortError).code).toBe(code);
      expect((e as PortError).status).toBe(status);
    },
  );
}

function multiProviderConfig(providers: object[]) {
  return loadConfig({
    HYPER_MCP_ADMIN_PROVIDERS: JSON.stringify(providers),
    HYPER_MCP_AUTH_REQUIRED: "true",
    HYPER_MCP_TRUST_MODE: "hosted",
  } as any);
}

describe("config — multi-provider admin trust root parsing", () => {
  it("legacy single-provider env produces a one-element provider list", () => {
    const cfg = loadConfig({
      HYPER_MCP_ADMIN_PUBLIC_JWK: JSON.stringify(providerAJwk),
      HYPER_MCP_ADMIN_ISSUER: "admin-agent",
      HYPER_MCP_ADMIN_AUDIENCE: "hyper-mcp",
      HYPER_MCP_ADMIN_KID: "admin-a",
    } as any);
    expect(cfg.adminProviders).toHaveLength(1);
    expect(cfg.adminProviders[0].issuer).toBe("admin-agent");
    expect(cfg.adminProviders[0].audience).toBe("hyper-mcp");
    expect(cfg.adminProviders[0].publicJwk).toBe(JSON.stringify(providerAJwk));
    expect(cfg.adminProviders[0].kid).toBe("admin-a");
  });

  it("parses a multi-provider JSON list", () => {
    const cfg = multiProviderConfig([
      { issuer: "admin-a", audience: "hyper-mcp", publicJwk: providerAJwk, kid: "admin-a" },
      { issuer: "admin-b", audience: "hyper-mcp", publicJwk: providerBJwk, kid: "admin-b" },
    ]);
    expect(cfg.adminProviders).toHaveLength(2);
    expect(cfg.adminProviders.map((p) => p.issuer)).toEqual(["admin-a", "admin-b"]);
  });

  it("accepts an inline publicJwk object OR string within the JSON list", () => {
    const cfg = multiProviderConfig([
      { issuer: "admin-a", audience: "hyper-mcp", publicJwk: providerAJwk },
    ]);
    expect(cfg.adminProviders[0].publicJwk).toBe(JSON.stringify(providerAJwk));

    const cfg2 = multiProviderConfig([
      { issuer: "admin-a", audience: "hyper-mcp", publicJwk: JSON.stringify(providerAJwk) },
    ]);
    expect(cfg2.adminProviders[0].publicJwk).toBe(JSON.stringify(providerAJwk));
  });

  it("zero providers when nothing is configured", () => {
    const cfg = loadConfig({ HYPER_MCP_AUTH_REQUIRED: "true" } as any);
    expect(cfg.adminProviders).toEqual([]);
  });

  it("empty PROVIDERS array means zero providers", () => {
    const cfg = multiProviderConfig([]);
    expect(cfg.adminProviders).toEqual([]);
  });

  it("rejects ambiguous legacy + multi-provider config", () => {
    expect(() =>
      loadConfig({
        HYPER_MCP_ADMIN_PUBLIC_JWK: JSON.stringify(providerAJwk),
        HYPER_MCP_ADMIN_ISSUER: "admin-agent",
        HYPER_MCP_ADMIN_AUDIENCE: "hyper-mcp",
        HYPER_MCP_ADMIN_PROVIDERS: JSON.stringify([{ issuer: "admin-a", audience: "hyper-mcp", publicJwk: providerAJwk }]),
      } as any),
    ).toThrow(/Ambiguous admin config/);
  });

  it("rejects duplicate issuers across providers", () => {
    expect(() =>
      multiProviderConfig([
        { issuer: "admin-x", audience: "hyper-mcp", publicJwk: providerAJwk },
        { issuer: "admin-x", audience: "hyper-mcp", publicJwk: providerBJwk },
      ]),
    ).toThrow(/duplicate issuer/);
  });

  it("rejects a provider with neither or both key sources", () => {
    expect(() =>
      multiProviderConfig([{ issuer: "admin-a", audience: "hyper-mcp" }]),
    ).toThrow(/exactly one of publicJwk or jwksUrl/);
    expect(() =>
      multiProviderConfig([
        { issuer: "admin-a", audience: "hyper-mcp", publicJwk: providerAJwk, jwksUrl: "https://x/jwks.json" },
      ]),
    ).toThrow(/exactly one of publicJwk or jwksUrl/);
  });

  it("rejects a provider missing issuer or audience", () => {
    expect(() =>
      multiProviderConfig([{ audience: "hyper-mcp", publicJwk: providerAJwk }]),
    ).toThrow(/issuer is required/);
    expect(() =>
      multiProviderConfig([{ issuer: "admin-a", publicJwk: providerAJwk }]),
    ).toThrow(/audience is required/);
  });

  it("rejects an invalid jwksUrl", () => {
    expect(() =>
      multiProviderConfig([{ issuer: "admin-a", audience: "hyper-mcp", jwksUrl: "not-a-url" }]),
    ).toThrow(/valid URL/);
  });

  it("assertStdioConfig: hosted + zero providers throws; hosted + providers passes", () => {
    expect(() => assertStdioConfig(loadConfig({ HYPER_MCP_TRUST_MODE: "hosted" } as any))).toThrow(/cannot start in hosted/);
    expect(() =>
      assertStdioConfig(
        multiProviderConfig([{ issuer: "admin-a", audience: "hyper-mcp", publicJwk: providerAJwk }]),
      ),
    ).not.toThrow();
  });
});

describe("validateAdminJwt — issuer-routed multi-provider verification", () => {
  it("routes by issuer and verifies against the matching provider", async () => {
    const cfg = multiProviderConfig([
      { issuer: "admin-a", audience: "hyper-mcp", publicJwk: providerAJwk, kid: "admin-a" },
      { issuer: "admin-b", audience: "hyper-mcp", publicJwk: providerBJwk, kid: "admin-b" },
    ]);
    const ctxA = await validateAdminJwt(await signAdmin({ key: providerAPrivate, issuer: "admin-a", kid: "admin-a" }), cfg);
    expect(ctxA.issuer).toBe("admin-a");
    expect(ctxA.scopes).toContain("accounts:admin");

    const ctxB = await validateAdminJwt(await signAdmin({ key: providerBPrivate, issuer: "admin-b", kid: "admin-b" }), cfg);
    expect(ctxB.issuer).toBe("admin-b");
  });

  it("rejects a token whose issuer matches no provider with 401", async () => {
    const cfg = multiProviderConfig([
      { issuer: "admin-a", audience: "hyper-mcp", publicJwk: providerAJwk },
    ]);
    await expectPortError(
      validateAdminJwt(await signAdmin({ key: providerAPrivate, issuer: "admin-ghost" }), cfg),
      "AUTH_FAILED",
      401,
    );
  });

  it("rejects a token whose issuer matches provider A but signed by provider B's key", async () => {
    const cfg = multiProviderConfig([
      { issuer: "admin-a", audience: "hyper-mcp", publicJwk: providerAJwk, kid: "admin-a" },
      { issuer: "admin-b", audience: "hyper-mcp", publicJwk: providerBJwk, kid: "admin-b" },
    ]);
    // Claims issuer admin-a but is signed by B's private key -> signature must fail.
    await expectPortError(
      validateAdminJwt(await signAdmin({ key: providerBPrivate, issuer: "admin-a", kid: "admin-b" }), cfg),
      "AUTH_FAILED",
      401,
    );
  });

  it("rejects a wrong audience for the matched provider with 401", async () => {
    const cfg = multiProviderConfig([
      { issuer: "admin-a", audience: "hyper-mcp", publicJwk: providerAJwk },
    ]);
    await expectPortError(
      validateAdminJwt(await signAdmin({ key: providerAPrivate, issuer: "admin-a", audience: "other-service" }), cfg),
      "AUTH_FAILED",
      401,
    );
  });

  it("rejects an expired admin JWT with 401", async () => {
    const cfg = multiProviderConfig([
      { issuer: "admin-a", audience: "hyper-mcp", publicJwk: providerAJwk },
    ]);
    await expectPortError(
      validateAdminJwt(await signAdmin({ key: providerAPrivate, issuer: "admin-a", expiresIn: "-1s" }), cfg),
      "AUTH_FAILED",
      401,
    );
  });

  it("rejects a valid-signature admin JWT missing accounts:admin with 403", async () => {
    const cfg = multiProviderConfig([
      { issuer: "admin-a", audience: "hyper-mcp", publicJwk: providerAJwk },
    ]);
    await expectPortError(
      validateAdminJwt(
        await signAdmin({ key: providerAPrivate, issuer: "admin-a", scopes: ["data:read"] }),
        cfg,
      ),
      "FORBIDDEN",
      403,
    );
  });

  it("returns 503 ADMIN_NOT_CONFIGURED when no providers are configured", async () => {
    const cfg = loadConfig({ HYPER_MCP_AUTH_REQUIRED: "true", HYPER_MCP_TRUST_MODE: "hosted" } as any);
    await expectPortError(
      validateAdminJwt(await signAdmin({ key: providerAPrivate, issuer: "admin-a" }), cfg),
      "ADMIN_NOT_CONFIGURED",
      503,
    );
  });

  it("verifies a JWKS-URL provider over a real HTTP server", async () => {
    const jwks = JSON.stringify({ keys: [providerAJwk] });
    const srv: Server = createHttpServer((_req, res) => {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(jwks);
    });
    await new Promise<void>((r) => srv.listen(0, "127.0.0.1", r));
    const jwksUrl = `http://127.0.0.1:${(srv.address() as any).port}/jwks.json`;
    try {
      const cfg = multiProviderConfig([
        { issuer: "admin-a", audience: "hyper-mcp", jwksUrl },
      ]);
      const ctx = await validateAdminJwt(await signAdmin({ key: providerAPrivate, issuer: "admin-a", kid: "admin-a" }), cfg);
      expect(ctx.issuer).toBe("admin-a");
      expect(ctx.scopes).toContain("accounts:admin");
    } finally {
      await new Promise<void>((r) => srv.close(() => r()));
    }
  });

  it("rejects a malformed token with 401 (no three-part JWT)", async () => {
    const cfg = multiProviderConfig([
      { issuer: "admin-a", audience: "hyper-mcp", publicJwk: providerAJwk },
    ]);
    await expectPortError(validateAdminJwt("not.a.jwt", cfg), "AUTH_FAILED", 401);
    await expectPortError(validateAdminJwt("two-parts.two", cfg), "AUTH_FAILED", 401);
  });

  it("mixes JWKS-URL and inline providers in one config", async () => {
    const jwks = JSON.stringify({ keys: [providerBJwk] });
    const srv: Server = createHttpServer((_req, res) => {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(jwks);
    });
    await new Promise<void>((r) => srv.listen(0, "127.0.0.1", r));
    const jwksUrl = `http://127.0.0.1:${(srv.address() as any).port}/jwks.json`;
    try {
      const cfg = multiProviderConfig([
        { issuer: "admin-a", audience: "hyper-mcp", publicJwk: providerAJwk, kid: "admin-a" },
        { issuer: "admin-b", audience: "hyper-mcp", jwksUrl, kid: "admin-b" },
      ]);
      const ctxA = await validateAdminJwt(await signAdmin({ key: providerAPrivate, issuer: "admin-a", kid: "admin-a" }), cfg);
      expect(ctxA.issuer).toBe("admin-a");
      const ctxB = await validateAdminJwt(await signAdmin({ key: providerBPrivate, issuer: "admin-b", kid: "admin-b" }), cfg);
      expect(ctxB.issuer).toBe("admin-b");
    } finally {
      await new Promise<void>((r) => srv.close(() => r()));
    }
  });
});
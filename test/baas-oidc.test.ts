import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createServer as createHttpServer, type Server } from "node:http";
import { generateKeyPair, SignJWT, exportJWK } from "jose";
import { createOidcIdentityResolver } from "../src/baas/identity-oidc.js";
import { loadConfig } from "../src/config.js";
import type { OidcProvider } from "../src/config.js";

let issuerKp: { privateKey: any; jwk: any };
let jwksServer: Server | undefined;
let jwksUrl = "";

beforeEach(async () => {
  const pair = await generateKeyPair("Ed25519", { extractable: true });
  issuerKp = { privateKey: pair.privateKey, jwk: { ...(await exportJWK(pair.publicKey)), kid: "oidc-1" } };
  const jwks = JSON.stringify({ keys: [issuerKp.jwk] });
  jwksServer = createHttpServer((_req, res) => { res.writeHead(200, { "content-type": "application/json" }); res.end(jwks); });
  await new Promise<void>(r => jwksServer!.listen(0, "127.0.0.1", r));
  jwksUrl = `http://127.0.0.1:${(jwksServer.address() as any).port}/jwks.json`;
});

afterEach(async () => { if (jwksServer) await new Promise<void>(r => jwksServer!.close(() => r())); });

function providers(accountId = "myapp"): OidcProvider[] {
  return [{ issuer: "https://clerk.example.com", audience: "hyper-mcp", jwksUrl, accountId }];
}


function tamperPayloadSub(token: string, sub: string) {
  const parts = token.split(".");
  const payload = JSON.parse(Buffer.from(parts[1], "base64url").toString("utf8"));
  payload.sub = sub;
  parts[1] = Buffer.from(JSON.stringify(payload), "utf8").toString("base64url");
  return parts.join(".");
}

function signJwt(opts: { sub?: string; iss?: string; aud?: string; expired?: boolean } = {}) {
  return new SignJWT({})
    .setProtectedHeader({ alg: "EdDSA", kid: "oidc-1" })
    .setIssuer(opts.iss ?? "https://clerk.example.com")
    .setAudience(opts.aud ?? "hyper-mcp")
    .setSubject(opts.sub ?? "user-42")
    .setExpirationTime(opts.expired ? "-1s" : "1h")
    .sign(issuerKp.privateKey);
}

describe("OidcIdentityResolver", () => {
  it("resolves a valid OIDC JWT to { accountId, userId=sub }", async () => {
    const r = createOidcIdentityResolver(providers());
    const ident = await r.resolve("myapp", await signJwt());
    expect(ident).toEqual({ accountId: "myapp", userId: "user-42" });
  });

  it("returns null for a missing credential", async () => {
    expect(await createOidcIdentityResolver(providers()).resolve("myapp", undefined)).toBeNull();
  });

  it("returns null for an unknown issuer", async () => {
    const ident = await createOidcIdentityResolver(providers()).resolve("myapp", await signJwt({ iss: "https://other.example.com" }));
    expect(ident).toBeNull();
  });

  it("returns null when the issuer is not bound to the route's accountId", async () => {
    const ident = await createOidcIdentityResolver(providers("myapp")).resolve("other-acct", await signJwt());
    expect(ident).toBeNull();
  });

  it("returns null for a wrong audience", async () => {
    const ident = await createOidcIdentityResolver(providers()).resolve("myapp", await signJwt({ aud: "someone-else" }));
    expect(ident).toBeNull();
  });

  it("returns null for an expired JWT", async () => {
    const ident = await createOidcIdentityResolver(providers()).resolve("myapp", await signJwt({ expired: true }));
    expect(ident).toBeNull();
  });

  it("returns null for a tampered token", async () => {
    const tok = await signJwt();
    const ident = await createOidcIdentityResolver(providers()).resolve("myapp", tok.slice(0, -2) + "AA");
    expect(ident).toBeNull();
  });

  it("does not trust a decoded subject when signature verification fails", async () => {
    const tok = await signJwt({ sub: "real-user" });
    const tampered = tamperPayloadSub(tok, "attacker-user");
    const ident = await createOidcIdentityResolver(providers()).resolve("myapp", tampered);
    expect(ident).toBeNull();
  });

  it("returns null when sub is missing", async () => {
    const tok = await new SignJWT({}).setProtectedHeader({ alg: "EdDSA", kid: "oidc-1" })
      .setIssuer("https://clerk.example.com").setAudience("hyper-mcp").setExpirationTime("1h").sign(issuerKp.privateKey);
    expect(await createOidcIdentityResolver(providers()).resolve("myapp", tok)).toBeNull();
  });
});

describe("config — OIDC providers parsing", () => {
  it("parses a valid provider list", () => {
    const cfg = loadConfig({ HYPER_MCP_BAAS_IDENTITY: "oidc", HYPER_MCP_BAAS_OIDC_PROVIDERS: JSON.stringify(providers()) } as any);
    expect(cfg.baasIdentity).toBe("oidc");
    expect(cfg.baasOidcProviders).toHaveLength(1);
    expect(cfg.baasOidcProviders[0].accountId).toBe("myapp");
  });

  it("rejects duplicate issuers", () => {
    const p = providers();
    expect(() => loadConfig({ HYPER_MCP_BAAS_OIDC_PROVIDERS: JSON.stringify([...p, ...p]) } as any)).toThrow(/duplicate issuer/);
  });

  it("rejects a provider missing accountId", () => {
    expect(() => loadConfig({ HYPER_MCP_BAAS_OIDC_PROVIDERS: JSON.stringify([{ issuer: "i", audience: "a", jwksUrl: "https://x/jwks" }]) } as any)).toThrow(/accountId is required/);
  });
});
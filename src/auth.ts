import { jwtVerify, createLocalJWKSet, createRemoteJWKSet, type JWK } from "jose";
import type { Config, AdminProvider } from "./config.js";
import { PortError } from "./errors.js";
import type { Ports } from "./ports/types.js";

export interface AuthContext {
  accountId: string;
  issuer: string;
  audience: string;
  scopes: string[];
  source: "admin" | "account";
}

const VALID_PORTS = ["data", "cache", "blob", "queue", "search", "accounts", "auth"];
const VALID_SCOPES = ["read", "write", "admin", "dangerous"];

export function isValidScope(scope: string): boolean {
  const [port, action] = scope.split(":");
  return VALID_PORTS.includes(port) && VALID_SCOPES.includes(action);
}

export function parsePorts(ports: Record<string, boolean>): string[] {
  const granted: string[] = [];
  for (const [scope, enabled] of Object.entries(ports)) {
    if (!isValidScope(scope)) {
      throw new PortError("INVALID_SCOPE", `Unknown scope: ${scope}`, 400);
    }
    if (enabled === true) granted.push(scope);
  }
  return granted;
}

export function hasScope(scopes: string[], required: string): boolean {
  if (scopes.includes("accounts:admin")) return true;
  const [port, action] = required.split(":");
  // wildcard: ports:*:scope
  if (scopes.includes(`${port}:admin`)) return true;
  return scopes.includes(required);
}

function extractBearer(authHeader: string | undefined): string {
  if (!authHeader || !authHeader.startsWith("Bearer ")) {
    throw new PortError("AUTH_MISSING", "Missing or malformed Authorization header", 401);
  }
  return authHeader.slice(7);
}

// ---- Admin JWT (multi-provider, issuer-routed) ----
//
// Convex's `auth.config.ts` declares a list of trusted OIDC providers and
// verifies a JWT by looking up the token's `iss` claim against that list, then
// fetching the matching provider's JWKS. We do the same here: decode the
// unverified `iss` to select a provider, then enforce signature/aud/exp via
// jose against that provider's key set. The unverified `iss` only chooses
// WHICH provider verifies — it never grants trust by itself.

type AdminKeySet = ReturnType<typeof createLocalJWKSet> | ReturnType<typeof createRemoteJWKSet>;

/** Cache of provider key sets, keyed by a stable provider key string. */
const adminKeySets = new Map<string, AdminKeySet>();

function providerKey(p: AdminProvider): string {
  return `${p.issuer}\u0000${p.audience}\u0000${p.publicJwk ?? ""}\u0000${p.jwksUrl ?? ""}`;
}

function getAdminKeySet(provider: AdminProvider, cacheSeconds: number): AdminKeySet {
  const key = providerKey(provider);
  const cached = adminKeySets.get(key);
  if (cached) return cached;

  let set: AdminKeySet;
  if (provider.publicJwk) {
    const jwk = JSON.parse(provider.publicJwk) as JWK;
    set = createLocalJWKSet({ keys: [jwk] });
  } else if (provider.jwksUrl) {
    set = createRemoteJWKSet(new URL(provider.jwksUrl), {
      cooldownDuration: cacheSeconds * 1000,
      cacheMaxAge: cacheSeconds * 1000,
    });
  } else {
    // Defensive: config validation should prevent this.
    throw new PortError("ADMIN_NOT_CONFIGURED", `Admin provider "${provider.issuer}" has no key material`, 503);
  }
  adminKeySets.set(key, set);
  return set;
}

function findProviderByIssuer(config: Config, issuer: string | undefined): AdminProvider | undefined {
  if (!issuer) return undefined;
  return config.adminProviders.find((p) => p.issuer === issuer);
}

export async function validateAdminJwt(token: string, config: Config): Promise<AuthContext> {
  if (config.adminProviders.length === 0) {
    throw new PortError("ADMIN_NOT_CONFIGURED", "Admin trust root not configured", 503);
  }

  // Decode the unverified token ONLY to read `iss` for provider routing.
  let unverifiedIssuer: string | undefined;
  try {
    const parts = token.split(".");
    if (parts.length !== 3) throw new Error("malformed");
    const payload = JSON.parse(Buffer.from(parts[1], "base64url").toString("utf8"));
    unverifiedIssuer = typeof payload.iss === "string" ? payload.iss : undefined;
  } catch {
    throw new PortError("AUTH_FAILED", "Admin JWT validation failed: malformed token", 401);
  }

  const provider = findProviderByIssuer(config, unverifiedIssuer);
  if (!provider) {
    throw new PortError(
      "AUTH_FAILED",
      `Admin JWT validation failed: no trusted provider for issuer "${unverifiedIssuer ?? ""}"`,
      401,
    );
  }

  const keySet = getAdminKeySet(provider, config.jwksCacheSeconds);
  try {
    const { payload } = await jwtVerify(token, keySet, {
      issuer: provider.issuer,
      audience: provider.audience,
    });

    const scopes = extractScopes(payload);
    if (!scopes.includes("accounts:admin")) {
      throw new PortError("FORBIDDEN", "Admin JWT lacks accounts:admin scope", 403);
    }

    return {
      accountId: "admin",
      issuer: provider.issuer,
      audience: provider.audience,
      scopes,
      source: "admin",
    };
  } catch (e) {
    if (e instanceof PortError) throw e;
    throw new PortError("AUTH_FAILED", `Admin JWT validation failed: ${(e as Error).message}`, 401);
  }
}

// ---- Account JWT ----

export async function validateAccountJwt(token: string, config: Config, backend: Ports): Promise<AuthContext> {
  try {
    // First decode without verification to get issuer + kid
    const parts = token.split(".");
    if (parts.length !== 3) throw new PortError("AUTH_FAILED", "Malformed JWT", 401);
    const header = JSON.parse(Buffer.from(parts[0], "base64url").toString("utf8"));
    const unverifiedPayload = JSON.parse(Buffer.from(parts[1], "base64url").toString("utf8"));

    const issuer = unverifiedPayload.iss;
    if (!issuer) throw new PortError("AUTH_FAILED", "JWT missing issuer", 401);

    const account = await backend.accountGetByIssuer(issuer);
    if (!account) throw new PortError("AUTH_FAILED", `No active account for issuer ${issuer}`, 401);

    // Resolve key(s)
    const keys = await backend.accountGetKeys(account.accountId);
    const jwksUrl = await backend.accountGetJwksUrl(account.accountId);

    let keySet: ReturnType<typeof createLocalJWKSet> | ReturnType<typeof createRemoteJWKSet>;

    if (keys.length > 0) {
      const jwkList = keys.map((k: any) => ({ ...k.publicJwk, kid: k.kid }));
      keySet = createLocalJWKSet({ keys: jwkList });
    } else if (jwksUrl?.jwksUrl) {
      keySet = createRemoteJWKSet(new URL(jwksUrl.jwksUrl), {
        cooldownDuration: config.jwksCacheSeconds * 1000,
        cacheMaxAge: config.jwksCacheSeconds * 1000,
      });
    } else {
      throw new PortError("AUTH_FAILED", `No keys registered for account ${account.accountId}`, 401);
    }

    const { payload } = await jwtVerify(token, keySet, {
      issuer: account.issuer,
      audience: account.audience,
    });

    // Scopes come from the account record (DB), not the JWT — the server is the authority.
    void payload;

    return {
      accountId: account.accountId,
      issuer: account.issuer,
      audience: account.audience,
      scopes: account.scopes,
      source: "account",
    };
  } catch (e) {
    if (e instanceof PortError) throw e;
    throw new PortError("AUTH_FAILED", `Account JWT validation failed: ${(e as Error).message}`, 401);
  }
}

function extractScopes(payload: any): string[] {
  if (Array.isArray(payload.scope)) return payload.scope;
  if (typeof payload.scope === "string") return payload.scope.split(" ");
  if (Array.isArray(payload.scp)) return payload.scp;
  if (typeof payload.scp === "string") return payload.scp.split(" ");
  return [];
}

export { extractBearer };
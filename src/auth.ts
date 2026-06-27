import { jwtVerify, createLocalJWKSet, createRemoteJWKSet, importJWK, type JWK } from "jose";
import type { Config, AdminTrustRoot } from "./config.js";
import { PortError } from "./errors.js";
import type { Ports } from "./ports/types.js";

export interface AuthContext {
  accountId: string;
  issuer: string;
  audience: string;
  scopes: string[];
  source: "admin" | "account";
}

const VALID_PORTS = ["data", "cache", "blob", "queue", "search", "accounts", "auth", "app"];
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

// ---- Admin JWT ----

let adminJwkSet: ReturnType<typeof createLocalJWKSet> | ReturnType<typeof createRemoteJWKSet> | null = null;
let adminTrustRootConfig: AdminTrustRoot | null = null;

function getAdminKeySet(config: Config) {
  if (adminJwkSet && adminTrustRootConfig === config.admin) return adminJwkSet;
  if (!config.admin) return null;

  adminTrustRootConfig = config.admin;

  if (config.admin.publicJwk) {
    const jwk = JSON.parse(config.admin.publicJwk) as JWK;
    adminJwkSet = createLocalJWKSet({ keys: [jwk] });
  } else if (config.admin.jwksUrl) {
    adminJwkSet = createRemoteJWKSet(new URL(config.admin.jwksUrl), {
      cooldownDuration: config.jwksCacheSeconds * 1000,
      cacheMaxAge: config.jwksCacheSeconds * 1000,
    });
  }
  return adminJwkSet;
}

export async function validateAdminJwt(token: string, config: Config): Promise<AuthContext> {
  if (!config.admin) throw new PortError("ADMIN_NOT_CONFIGURED", "Admin trust root not configured", 503);

  const keySet = getAdminKeySet(config);
  if (!keySet) throw new PortError("ADMIN_NOT_CONFIGURED", "Admin trust root not configured", 503);

  try {
    const { payload } = await jwtVerify(token, keySet, {
      issuer: config.admin.issuer,
      audience: config.admin.audience,
    });

    const scopes = extractScopes(payload);
    if (!scopes.includes("accounts:admin")) {
      throw new PortError("FORBIDDEN", "Admin JWT lacks accounts:admin scope", 403);
    }

    return {
      accountId: "admin",
      issuer: config.admin.issuer,
      audience: config.admin.audience,
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
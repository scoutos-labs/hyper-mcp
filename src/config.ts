/** A single trusted admin identity provider in a Convex-style trust list. */
export interface AdminProvider {
  /** Optional stable id for logging / cache keys. */
  id?: string;
  /** JWT issuer this provider trusts (used to route verification by `iss`). */
  issuer: string;
  /** Required JWT audience this provider trusts. */
  audience: string;
  /** Inline public JWK JSON. Exactly one of `publicJwk` / `jwksUrl`. */
  publicJwk?: string;
  /** Remote JWKS URL. Exactly one of `publicJwk` / `jwksUrl`. */
  jwksUrl?: string;
  /** Optional key id pinning hint. */
  kid?: string;
}

export type TrustMode = "local" | "hosted";

/**
 * Configurable resource limits. All default to the pre-config hardcoded values
 * so existing deployments keep their behavior. Each cap is the ceiling applied
 * per request (page/batch caps clamp the caller's limit) or per write (size
 * caps reject oversize payloads with a 413).
 */
export interface ResourceLimits {
  /** Max bytes for a cache value (reject > cap with 413 VALUE_TOO_LARGE). */
  maxCacheBytes: number;
  /** Max bytes for a blob payload (reject > cap with 413 BLOB_FILE_TOO_LARGE). */
  maxBlobBytes: number;
  /** Max page size for data_find (caller limit is clamped to this). */
  maxDataPageSize: number;
  /** Max page size for blob_list (caller limit is clamped to this). */
  maxBlobListPageSize: number;
  /** Max batch size for queue_poll (caller limit is clamped to this). */
  maxQueuePollBatch: number;
  /** Max page size for search_query (caller size is clamped to this). */
  maxSearchPageSize: number;
}

/** Defaults match the original hardcoded constants in PgliteBackend. */
export const DEFAULT_LIMITS: ResourceLimits = {
  maxCacheBytes: 1024 * 1024, // 1 MiB
  maxBlobBytes: 100 * 1024 * 1024, // 100 MiB
  maxDataPageSize: 1000,
  maxBlobListPageSize: 1000,
  maxQueuePollBatch: 10000,
  maxSearchPageSize: 10000,
};

export interface Config {
  pgDir: string;
  readOnly: boolean;
  allowDangerous: boolean;
  authRequired: boolean;
  /**
   * Trusted admin identity providers (Convex `auth.config.ts` analogue).
   * Empty when no admin trust root is configured. Verification routes by the
   * token's `iss` claim to the matching provider.
   */
  adminProviders: AdminProvider[];
  jwksCacheSeconds: number;
  backend: string;
  /** "local" = trusted, tools run as the default account without auth;
   *  "hosted" = auth required, tools fail closed without an auth context. */
  trustMode: TrustMode;
  /** True when trustMode was derived rather than set explicitly via env. */
  trustModeInferred: boolean;
  /** Whether /metrics is publicly readable (default true). When false, /metrics requires an admin JWT. */
  metricsPublic: boolean;
  /** Default session TTL in seconds for the auth port (auth_create_session). */
  authSessionTtlSeconds: number;
  /** Wall-clock timeout (ms) for a single BaaS function call via /u/:accountId/:fn. */
  functionTimeoutMs: number;
  /** Configurable resource limits, applied by the backend adapter. */
  limits: ResourceLimits;
}

/**
 * Parse the admin trust root(s).
 *
 * Two mutually exclusive config styles are supported:
 *
 * 1. Legacy single provider (backwards compatible):
 *      HYPER_MCP_ADMIN_PUBLIC_JWK | HYPER_MCP_ADMIN_JWKS_URL
 *      HYPER_MCP_ADMIN_ISSUER, HYPER_MCP_ADMIN_AUDIENCE, HYPER_MCP_ADMIN_KID?
 *
 * 2. Multi-provider list (Convex `auth.config.ts` analogue):
 *      HYPER_MCP_ADMIN_PROVIDERS = JSON array of provider objects
 *
 * Setting both styles is a startup error. Within the multi-provider list,
 * issuers must be unique (verification routes by `iss`) and each provider
 * must declare exactly one of `publicJwk` / `jwksUrl`.
 */
function parseAdminProviders(env: Record<string, string | undefined>): AdminProvider[] {
  const legacyJwk = env.HYPER_MCP_ADMIN_PUBLIC_JWK;
  const legacyJwksUrl = env.HYPER_MCP_ADMIN_JWKS_URL;
  const multi = env.HYPER_MCP_ADMIN_PROVIDERS;
  const legacyPresent = !!legacyJwk || !!legacyJwksUrl;
  const multiPresent = multi !== undefined && multi !== "";

  if (legacyPresent && multiPresent) {
    throw new Error(
      "Ambiguous admin config: set either the legacy single-provider vars " +
        "(HYPER_MCP_ADMIN_PUBLIC_JWK or HYPER_MCP_ADMIN_JWKS_URL) or " +
        "HYPER_MCP_ADMIN_PROVIDERS (multi-provider list), not both.",
    );
  }

  if (multiPresent) return parseProvidersJson(multi!);
  if (!legacyPresent) return [];

  if (legacyJwk && legacyJwksUrl) {
    throw new Error("Provide either HYPER_MCP_ADMIN_PUBLIC_JWK or HYPER_MCP_ADMIN_JWKS_URL, not both");
  }
  const issuer = env.HYPER_MCP_ADMIN_ISSUER;
  const audience = env.HYPER_MCP_ADMIN_AUDIENCE;
  if (!issuer || !audience) {
    throw new Error(
      "HYPER_MCP_ADMIN_ISSUER and HYPER_MCP_ADMIN_AUDIENCE are required when an admin trust root is configured",
    );
  }
  return [
    {
      issuer,
      audience,
      publicJwk: legacyJwk || undefined,
      jwksUrl: legacyJwksUrl || undefined,
      kid: env.HYPER_MCP_ADMIN_KID,
    },
  ];
}

function parseProvidersJson(raw: string): AdminProvider[] {
  let arr: unknown;
  try {
    arr = JSON.parse(raw);
  } catch (e) {
    throw new Error(`HYPER_MCP_ADMIN_PROVIDERS must be a JSON array: ${(e as Error).message}`);
  }
  if (!Array.isArray(arr)) {
    throw new Error("HYPER_MCP_ADMIN_PROVIDERS must be a JSON array of provider objects");
  }
  if (arr.length === 0) return [];

  const providers: AdminProvider[] = [];
  const seenIssuers = new Set<string>();
  for (let i = 0; i < arr.length; i++) {
    const p = arr[i];
    if (!p || typeof p !== "object") {
      throw new Error(`HYPER_MCP_ADMIN_PROVIDERS[${i}] must be an object`);
    }
    const obj = p as Record<string, unknown>;
    const issuer = obj.issuer;
    const audience = obj.audience;
    if (typeof issuer !== "string" || !issuer) {
      throw new Error(`HYPER_MCP_ADMIN_PROVIDERS[${i}].issuer is required`);
    }
    if (typeof audience !== "string" || !audience) {
      throw new Error(`HYPER_MCP_ADMIN_PROVIDERS[${i}].audience is required`);
    }
    const hasJwk = !!obj.publicJwk;
    const hasUrl = !!obj.jwksUrl;
    if (hasJwk === hasUrl) {
      throw new Error(
        `HYPER_MCP_ADMIN_PROVIDERS[${i}] must set exactly one of publicJwk or jwksUrl`,
      );
    }
    if (seenIssuers.has(issuer)) {
      throw new Error(
        `HYPER_MCP_ADMIN_PROVIDERS duplicate issuer "${issuer}"; issuers must be unique for issuer-routed verification`,
      );
    }
    seenIssuers.add(issuer);

    let publicJwkStr: string | undefined;
    if (hasJwk) {
      // Accept either a JSON string or an embedded JWK object.
      publicJwkStr =
        typeof obj.publicJwk === "string" ? (obj.publicJwk as string) : JSON.stringify(obj.publicJwk);
    }
    let jwksUrl: string | undefined;
    if (hasUrl) {
      if (typeof obj.jwksUrl !== "string") {
        throw new Error(`HYPER_MCP_ADMIN_PROVIDERS[${i}].jwksUrl must be a string URL`);
      }
      jwksUrl = obj.jwksUrl as string;
      try {
        new URL(jwksUrl);
      } catch {
        throw new Error(`HYPER_MCP_ADMIN_PROVIDERS[${i}].jwksUrl is not a valid URL`);
      }
    }

    providers.push({
      id: typeof obj.id === "string" ? (obj.id as string) : undefined,
      issuer,
      audience,
      publicJwk: publicJwkStr,
      jwksUrl,
      kid: typeof obj.kid === "string" ? (obj.kid as string) : undefined,
    });
  }
  return providers;
}

function parsePositiveInt(env: Record<string, string | undefined>, key: string, fallback: number): number {
  const raw = env[key];
  if (raw === undefined || raw === "") return fallback;
  const n = Number(raw);
  if (!Number.isFinite(n) || !Number.isInteger(n) || n <= 0) {
    throw new Error(`${key} must be a positive integer, got: ${JSON.stringify(raw)}`);
  }
  return n;
}

function parseLimits(env: Record<string, string | undefined>): ResourceLimits {
  return {
    maxCacheBytes: parsePositiveInt(env, "HYPER_MCP_MAX_CACHE_BYTES", DEFAULT_LIMITS.maxCacheBytes),
    maxBlobBytes: parsePositiveInt(env, "HYPER_MCP_MAX_BLOB_BYTES", DEFAULT_LIMITS.maxBlobBytes),
    maxDataPageSize: parsePositiveInt(env, "HYPER_MCP_MAX_DATA_PAGE_SIZE", DEFAULT_LIMITS.maxDataPageSize),
    maxBlobListPageSize: parsePositiveInt(env, "HYPER_MCP_MAX_BLOB_LIST_PAGE_SIZE", DEFAULT_LIMITS.maxBlobListPageSize),
    maxQueuePollBatch: parsePositiveInt(env, "HYPER_MCP_MAX_QUEUE_POLL_BATCH", DEFAULT_LIMITS.maxQueuePollBatch),
    maxSearchPageSize: parsePositiveInt(env, "HYPER_MCP_MAX_SEARCH_PAGE_SIZE", DEFAULT_LIMITS.maxSearchPageSize),
  };
}

export function loadConfig(env = process.env as Record<string, string | undefined>): Config {
  const adminProviders = parseAdminProviders(env);
  const authRequired = env.HYPER_MCP_AUTH_REQUIRED !== "false";

  // Trust mode: explicit env wins; otherwise infer from authRequired and warn.
  const explicit = env.HYPER_MCP_TRUST_MODE;
  let trustMode: TrustMode;
  let trustModeInferred = false;
  if (explicit === "local" || explicit === "hosted") {
    trustMode = explicit;
  } else {
    trustModeInferred = true;
    trustMode = authRequired ? "hosted" : "local";
  }

  return {
    pgDir: env.HYPER_MCP_PGLITE_DIR || ".hyper-mcp/pgdata",
    readOnly: env.HYPER_MCP_READONLY === "true",
    allowDangerous: env.HYPER_MCP_ALLOW_DANGEROUS === "true",
    authRequired,
    adminProviders,
    jwksCacheSeconds: Number(env.HYPER_MCP_JWKS_CACHE_SECONDS || 300),
    backend: env.HYPER_MCP_BACKEND || "pglite",
    trustMode,
    trustModeInferred,
    metricsPublic: env.HYPER_MCP_METRICS_PUBLIC !== "false",
    authSessionTtlSeconds: parsePositiveInt(env, "HYPER_MCP_AUTH_SESSION_TTL_SECONDS", 86400),
    functionTimeoutMs: parsePositiveInt(env, "HYPER_MCP_FUNCTION_TIMEOUT_MS", 5000),
    limits: parseLimits(env),
  };
}

/**
 * Startup guard for the stdio transport. In hosted trust mode, stdio has no
 * HTTP bearer-token step, so it cannot establish an auth context. Without an
 * admin trust root there is no way to authenticate at all — refuse to start
 * rather than silently running tools as the default account.
 */
export function assertStdioConfig(config: Config): void {
  if (config.trustMode === "hosted" && config.adminProviders.length === 0) {
    throw new Error(
      "hyper-mcp stdio cannot start in hosted trust mode without an admin trust root. " +
        "Set HYPER_MCP_TRUST_MODE=local for local stdio, or configure HYPER_MCP_ADMIN_* env vars " +
        "(or HYPER_MCP_ADMIN_PROVIDERS).",
    );
  }
}
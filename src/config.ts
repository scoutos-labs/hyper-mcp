export interface AdminTrustRoot {
  publicJwk?: string;
  jwksUrl?: string;
  issuer: string;
  audience: string;
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
  admin: AdminTrustRoot | null;
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
  /** Configurable resource limits, applied by the backend adapter. */
  limits: ResourceLimits;
}

function parseAdminTrustRoot(env: Record<string, string | undefined>): AdminTrustRoot | null {
  const publicJwk = env.HYPER_MCP_ADMIN_PUBLIC_JWK;
  const jwksUrl = env.HYPER_MCP_ADMIN_JWKS_URL;
  const issuer = env.HYPER_MCP_ADMIN_ISSUER;
  const audience = env.HYPER_MCP_ADMIN_AUDIENCE;

  if (!publicJwk && !jwksUrl) return null;
  if (publicJwk && jwksUrl) {
    throw new Error("Provide either HYPER_MCP_ADMIN_PUBLIC_JWK or HYPER_MCP_ADMIN_JWKS_URL, not both");
  }
  if (!issuer || !audience) {
    throw new Error("HYPER_MCP_ADMIN_ISSUER and HYPER_MCP_ADMIN_AUDIENCE are required when admin trust root is configured");
  }

  return {
    publicJwk: publicJwk || undefined,
    jwksUrl: jwksUrl || undefined,
    issuer,
    audience,
    kid: env.HYPER_MCP_ADMIN_KID,
  };
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
  const admin = parseAdminTrustRoot(env);
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
    admin,
    jwksCacheSeconds: Number(env.HYPER_MCP_JWKS_CACHE_SECONDS || 300),
    backend: env.HYPER_MCP_BACKEND || "pglite",
    trustMode,
    trustModeInferred,
    metricsPublic: env.HYPER_MCP_METRICS_PUBLIC !== "false",
    authSessionTtlSeconds: parsePositiveInt(env, "HYPER_MCP_AUTH_SESSION_TTL_SECONDS", 86400),
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
  if (config.trustMode === "hosted" && !config.admin) {
    throw new Error(
      "hyper-mcp stdio cannot start in hosted trust mode without an admin trust root. " +
        "Set HYPER_MCP_TRUST_MODE=local for local stdio, or configure HYPER_MCP_ADMIN_* env vars.",
    );
  }
}
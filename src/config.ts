export interface AdminTrustRoot {
  publicJwk?: string;
  jwksUrl?: string;
  issuer: string;
  audience: string;
  kid?: string;
}

export type TrustMode = "local" | "hosted";

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
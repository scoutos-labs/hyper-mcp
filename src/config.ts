export interface AdminTrustRoot {
  publicJwk?: string;
  jwksUrl?: string;
  issuer: string;
  audience: string;
  kid?: string;
}

export interface Config {
  pgDir: string;
  readOnly: boolean;
  allowDangerous: boolean;
  authRequired: boolean;
  admin: AdminTrustRoot | null;
  jwksCacheSeconds: number;
  backend: string;
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
  return {
    pgDir: env.HYPER_MCP_PGLITE_DIR || ".hyper-mcp/pgdata",
    readOnly: env.HYPER_MCP_READONLY === "true",
    allowDangerous: env.HYPER_MCP_ALLOW_DANGEROUS === "true",
    authRequired: env.HYPER_MCP_AUTH_REQUIRED !== "false",
    admin,
    jwksCacheSeconds: Number(env.HYPER_MCP_JWKS_CACHE_SECONDS || 300),
    backend: env.HYPER_MCP_BACKEND || "pglite",
  };
}

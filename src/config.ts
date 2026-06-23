export interface Config {
  pgDir: string;
  readOnly: boolean;
  allowDangerous: boolean;
}

export function loadConfig(env = process.env): Config {
  return {
    pgDir: env.HYPER_MCP_PGLITE_DIR || ".hyper-mcp/pgdata",
    readOnly: env.HYPER_MCP_READONLY === "true",
    allowDangerous: env.HYPER_MCP_ALLOW_DANGEROUS === "true",
  };
}

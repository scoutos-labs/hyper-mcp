#!/usr/bin/env node
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { loadConfig, assertStdioConfig } from "./config.js";
import { createServer } from "./server.js";
import { createPorts } from "./ports/factory.js";
import { logger } from "./logger.js";

async function main() {
  const config = loadConfig();

  if (config.trustModeInferred) {
    logger.warn(
      `HYPER_MCP_TRUST_MODE not set; inferred "${config.trustMode}". Set it explicitly to remove this warning.`,
      { trustMode: config.trustMode },
    );
  }

  // Hosted trust mode without an admin trust root cannot authenticate anyone,
  // and stdio has no HTTP bearer-token step. Refuse to start rather than
  // silently running tools as the default account.
  assertStdioConfig(config);

  if (config.trustMode === "hosted") {
    logger.warn(
      "stdio transport cannot attach an auth context; in hosted trust mode every tool call will be rejected as AUTH_REQUIRED. Use HYPER_MCP_TRUST_MODE=local for local stdio.",
      { trustMode: config.trustMode },
    );
  }

  const server = createServer(config, () => createPorts(config));
  const transport = new StdioServerTransport();
  await server.connect(transport);
}

main().catch((error) => {
  console.error("hyper-mcp server failed", error);
  process.exit(1);
});
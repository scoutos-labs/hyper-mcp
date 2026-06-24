#!/usr/bin/env node
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { loadConfig } from "./config.js";
import { createServer } from "./server.js";
import { PgliteBackend } from "./pglite-backend.js";

async function main() {
  const config = loadConfig();
  const backend = new PgliteBackend(config.pgDir);
  const server = createServer(config, () => Promise.resolve(backend));
  const transport = new StdioServerTransport();
  await server.connect(transport);
}

main().catch((error) => {
  console.error("hyper-mcp server failed", error);
  process.exit(1);
});

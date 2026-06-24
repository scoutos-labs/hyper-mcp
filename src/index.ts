#!/usr/bin/env node
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { loadConfig } from "./config.js";
import { createServer } from "./server.js";
import { createPorts } from "./ports/factory.js";

async function main() {
  const config = loadConfig();
  const server = createServer(config, () => createPorts(config));
  const transport = new StdioServerTransport();
  await server.connect(transport);
}

main().catch((error) => {
  console.error("hyper-mcp server failed", error);
  process.exit(1);
});

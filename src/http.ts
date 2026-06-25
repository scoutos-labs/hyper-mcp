#!/usr/bin/env node
import { loadConfig } from "./config.js";
import { createApp } from "./app.js";
import { logger } from "./logger.js";
import type { Ports } from "./ports/types.js";
import { createPorts, closePorts } from "./ports/factory.js";

type PortsGetter = () => Promise<Ports>;

const port = Number(process.env.PORT || 3000);
const host = process.env.HOST || "0.0.0.0";
const config = loadConfig();

logger.info("hyper-mcp starting", {
  pgDir: config.pgDir,
  readOnly: config.readOnly,
  allowDangerous: config.allowDangerous,
  authRequired: config.authRequired,
  adminConfigured: !!config.admin,
  trustMode: config.trustMode,
});

if (config.trustModeInferred) {
  logger.warn(
    `HYPER_MCP_TRUST_MODE not set; inferred "${config.trustMode}". Set it explicitly to remove this warning.`,
    { trustMode: config.trustMode },
  );
}

// Lazy ports via factory
let portsPromise: Promise<Ports> | undefined;
const getPorts: PortsGetter = () => {
  portsPromise ??= createPorts(config).then(ports => {
    logger.info("Backend ready", { backend: config.backend, pgDir: config.pgDir });
    return ports;
  });
  return portsPromise;
};

const app = createApp(config, getPorts);

const listener = app.listen(port, host, (error?: Error) => {
  if (error) {
    logger.error("Failed to start HTTP server", { error: error.message, stack: error.stack });
    process.exit(1);
  }
  logger.info("hyper-mcp HTTP server listening", { host, port, mcpEndpoint: "/mcp" });
});

async function shutdown() {
  logger.info("Shutting down hyper-mcp HTTP server...");
  listener.close();
  await closePorts();
  logger.info("hyper-mcp HTTP server stopped");
  process.exit(0);
}

process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);

process.on("uncaughtException", (error) => {
  logger.error("Uncaught exception", { error: error.message, stack: error.stack });
  process.exit(1);
});

process.on("unhandledRejection", (reason) => {
  logger.error("Unhandled rejection", { reason: reason instanceof Error ? reason.message : String(reason), stack: reason instanceof Error ? reason.stack : undefined });
});
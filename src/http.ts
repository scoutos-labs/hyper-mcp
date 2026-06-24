#!/usr/bin/env node
import { createMcpExpressApp } from "@modelcontextprotocol/sdk/server/express.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { loadConfig } from "./config.js";
import { createServer } from "./server.js";
import { landingPage } from "./landing.js";
import { createAuthRoutes } from "./auth-routes.js";
import { validateAccountJwt, extractBearer } from "./auth.js";
import { PortError } from "./errors.js";
import { runWithAuth } from "./auth-context.js";
import { logger, startTimer, requestLogger, getMetrics, recordAuthFailure } from "./logger.js";
import type { Ports } from "./ports/types.js";
import { createPorts, closePorts } from "./ports/factory.js";

const port = Number(process.env.PORT || 3000);
const host = process.env.HOST || "0.0.0.0";
const config = loadConfig();

logger.info("hyper-mcp starting", {
  pgDir: config.pgDir,
  readOnly: config.readOnly,
  allowDangerous: config.allowDangerous,
  authRequired: config.authRequired,
  adminConfigured: !!config.admin,
});

// Lazy ports via factory
let portsPromise: Promise<Ports> | undefined;
const getPorts = () => {
  portsPromise ??= createPorts(config).then(ports => {
    logger.info("Backend ready", { backend: config.backend, pgDir: config.pgDir });
    return ports;
  });
  return portsPromise;
};

const app = createMcpExpressApp({ host });

// Request logging middleware
app.use(requestLogger());

// Public routes
app.get("/", (_req: any, res: any) => {
  res.status(200).type("html").send(landingPage());
});

app.get("/health", (_req: any, res: any) => {
  res.status(200).json({
    ok: true,
    service: "hyper-mcp",
    backend: "pglite",
    persistentDir: config.pgDir,
    readOnly: config.readOnly,
    authRequired: config.authRequired,
    adminConfigured: !!config.admin,
  });
});

app.get("/metrics", (_req: any, res: any) => {
  res.status(200).json(getMetrics());
});

// Auth routes (admin-protected) — delegate to lazy Ports
const authBackend = {
  accountCreate: async (...args: any[]) => (await getPorts()).accountCreate(...(args as Parameters<Ports["accountCreate"]>)),
  accountGet: async (...args: any[]) => (await getPorts()).accountGet(...(args as [string])),
  accountGetByIssuer: async (...args: any[]) => (await getPorts()).accountGetByIssuer(...(args as [string])),
  accountDisable: async (...args: any[]) => (await getPorts()).accountDisable(...(args as [string])),
  accountAddKey: async (...args: any[]) => (await getPorts()).accountAddKey(...(args as [string, string, object])),
  accountGetKeys: async (...args: any[]) => (await getPorts()).accountGetKeys(...(args as [string])),
  accountAddJwksUrl: async (...args: any[]) => (await getPorts()).accountAddJwksUrl(...(args as [string, string])),
  accountGetJwksUrl: async (...args: any[]) => (await getPorts()).accountGetJwksUrl(...(args as [string])),
  auditLog: async (...args: any[]) => (await getPorts()).auditLog(...(args as [string | null, string | null, string, string])),
  auditLogQuery: async (...args: any[]) => (await getPorts()).auditLogQuery(...(args as [string])),
} as unknown as Ports;

const authRoutes = createAuthRoutes(config, authBackend);

app.post("/register", authRoutes.register);
app.post("/unregister", authRoutes.unregister);

// Protected MCP endpoint
app.post("/mcp", async (req: any, res: any) => {
  const timer = startTimer("mcp.request");

  if (config.authRequired) {
    if (!config.admin) {
      timer.end({ authFailed: true, errorCode: "ADMIN_NOT_CONFIGURED", status: 503 });
      recordAuthFailure();
      logger.warn("MCP auth unavailable", { code: "ADMIN_NOT_CONFIGURED", status: 503 });
      return res.status(503).json({
        jsonrpc: "2.0",
        error: { code: -32001, message: "ADMIN_NOT_CONFIGURED", data: { status: 503 } },
        id: req.body?.id ?? null,
      });
    }

    try {
      const token = extractBearer(req.headers.authorization);
      const ports = await getPorts();
      const authCtx = await validateAccountJwt(token, config, ports);
      (req as any).__auth = authCtx;
      logger.debug("MCP auth success", { accountId: authCtx.accountId, issuer: authCtx.issuer });
    } catch (e) {
      const err = e as PortError;
      timer.end({ authFailed: true, errorCode: err.code, status: err.status || 401 });
      recordAuthFailure();
      logger.warn("MCP auth failed", { code: err.code, status: err.status || 401, message: err.message });
      return res.status(err.status || 401).json({
        jsonrpc: "2.0",
        error: { code: -32001, message: err.code || "AUTH_FAILED", data: { status: err.status || 401 } },
        id: req.body?.id ?? null,
      });
    }
  }

  // Stateless streamable HTTP: each request gets a fresh MCP server + transport.
  const requestServer = createServer(config, getPorts);
  const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
  res.on("close", () => {
    transport.close().catch(() => {});
    requestServer.close().catch(() => {});
  });

  try {
    await requestServer.connect(transport);
    await runWithAuth(req.__auth, () => transport.handleRequest(req, res, req.body));
    timer.end({ accountId: req.__auth?.accountId });
  } catch (error) {
    timer.end({ error: true });
    logger.error("MCP request failed", {
      error: (error as Error).message,
      stack: (error as Error).stack,
      accountId: req.__auth?.accountId,
    });
    if (!res.headersSent) {
      res.status(500).json({
        jsonrpc: "2.0",
        error: { code: -32603, message: "Internal server error" },
        id: req.body?.id ?? null,
      });
    }
  }
});

app.get("/mcp", (_req: any, res: any) => {
  res.status(405).json({
    jsonrpc: "2.0",
    error: { code: -32000, message: "Method not allowed. Use POST /mcp." },
    id: null,
  });
});

app.delete("/mcp", (_req: any, res: any) => {
  res.status(405).json({
    jsonrpc: "2.0",
    error: { code: -32000, message: "Method not allowed." },
    id: null,
  });
});


// Express error handler — catches errors that escape route handlers
app.use((err: any, _req: any, res: any, _next: any) => {
  logger.error("unhandled express error", {
    error: err?.message || String(err),
    stack: err?.stack,
    status: err?.status || 500,
  });
  if (!res.headersSent) {
    res.status(err?.status || 500).json({
      jsonrpc: "2.0",
      error: { code: -32603, message: err?.message || "Internal server error" },
      id: null,
    });
  }
});

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

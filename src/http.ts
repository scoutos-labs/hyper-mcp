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
import { logger, startTimer, requestLogger, getMetrics, recordToolCall, recordAuthFailure } from "./logger.js";
import type { PgliteBackend } from "./pglite-backend.js";

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

// Lazy backend
let backendPromise: Promise<PgliteBackend> | undefined;
const getBackend = () => {
  backendPromise ??= import("./pglite-backend.js").then(({ PgliteBackend }) => {
    logger.info("PGLite backend initializing", { pgDir: config.pgDir });
    const backend = new PgliteBackend(config.pgDir);
    logger.info("PGLite backend ready", { pgDir: config.pgDir });
    return backend;
  });
  return backendPromise;
};

const server = createServer(config, getBackend);
const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });

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

// Auth routes (admin-protected)
const authRoutes = createAuthRoutes(config, {
  accountCreate: async (...args: any[]) => (await getBackend()).accountCreate(...(args as [any, any, any, any, any])),
  accountGet: async (...args: any[]) => (await getBackend()).accountGet(...(args as [any])),
  accountGetByIssuer: async (...args: any[]) => (await getBackend()).accountGetByIssuer(...(args as [any])),
  accountDisable: async (...args: any[]) => (await getBackend()).accountDisable(...(args as [any])),
  accountAddKey: async (...args: any[]) => (await getBackend()).accountAddKey(...(args as [any, any, any])),
  accountGetKeys: async (...args: any[]) => (await getBackend()).accountGetKeys(...(args as [any])),
  accountAddJwksUrl: async (...args: any[]) => (await getBackend()).accountAddJwksUrl(...(args as [any, any])),
  accountGetJwksUrl: async (...args: any[]) => (await getBackend()).accountGetJwksUrl(...(args as [any])),
  accountSetCachedJwks: async (...args: any[]) => (await getBackend()).accountSetCachedJwks(...(args as [any, any, any])),
  auditLog: async (...args: any[]) => (await getBackend()).auditLog(...(args as [any, any, any, any, any])),
} as unknown as PgliteBackend);

app.post("/register", authRoutes.register);
app.post("/unregister", authRoutes.unregister);

// Protected MCP endpoint
app.post("/mcp", async (req: any, res: any) => {
  const timer = startTimer("mcp.request");

  if (config.authRequired && config.admin) {
    try {
      const token = extractBearer(req.headers.authorization);
      const backend = await getBackend();
      const authCtx = await validateAccountJwt(token, config, backend);
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
        id: null,
      });
    }
  }

  try {
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
        id: null,
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

await server.connect(transport);

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
  await transport.close();
  await server.close();
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

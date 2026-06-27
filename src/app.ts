import { createMcpExpressApp } from "@modelcontextprotocol/sdk/server/express.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import type { Config } from "./config.js";
import { createServer } from "./server.js";
import { landingPage } from "./landing.js";
import { createAuthRoutes } from "./auth-routes.js";
import { createOpaqueTokenResolver } from "./baas/identity.js";
import { buildFunctionContext } from "./baas/context.js";
import { createVmFunctionRuntime, VM_RUNTIME_NAME } from "./baas/runtime.js";
import { validateAccountJwt, validateAdminJwt, extractBearer } from "./auth.js";
import { PortError } from "./errors.js";
import { runWithAuth } from "./auth-context.js";
import { logger, startTimer, requestLogger, getMetrics, recordAuthFailure } from "./logger.js";
import type { Ports } from "./ports/types.js";

export type PortsGetter = () => Promise<Ports>;

/**
 * Build the Express application with all routes wired (public, admin, MCP).
 * Transport-agnostic: the caller is responsible for listening. Pure factory —
 * no side effects, no port binding — so HTTP route behavior is testable.
 */
export function createApp(config: Config, getPorts: PortsGetter): ReturnType<typeof createMcpExpressApp> {
  const app = createMcpExpressApp({ host: process.env.HOST || "0.0.0.0" });

  // Request logging middleware
  app.use(requestLogger());

  // BaaS function runtime. Created once; reused across /u/:accountId/:fn calls.
  const functionRuntime = createVmFunctionRuntime();
  if (functionRuntime.name === VM_RUNTIME_NAME) {
    logger.warn(
      `BaaS function runtime is "${functionRuntime.name}" — NOT a security barrier; only run code you trust. Use the Daytona adapter for untrusted/multi-tenant functions.`,
      { runtime: functionRuntime.name },
    );
  } else {
    logger.info("BaaS function runtime", { runtime: functionRuntime.name });
  }

  // Public routes
  app.get("/", (_req: any, res: any) => {
    res.status(200).type("html").send(landingPage());
  });

  app.get("/health", (_req: any, res: any) => {
    res.status(200).json({
      ok: true,
      service: "hyper-mcp",
      backend: config.backend,
      persistentDir: config.pgDir,
      readOnly: config.readOnly,
      authRequired: config.authRequired,
      adminConfigured: !!config.admin,
    });
  });

  app.get("/metrics", async (req: any, res: any) => {
    if (!config.metricsPublic) {
      try {
        const token = extractBearer(req.headers.authorization);
        await validateAdminJwt(token, config);
      } catch (e) {
        const err = e as PortError;
        return res.status(err.status || 401).json({ error: err.code || "AUTH_FAILED", message: err.message });
      }
    }
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
    accountClearAuth: async (...args: any[]) => (await getPorts()).accountClearAuth(...(args as [string])),
    auditLog: async (...args: any[]) => (await getPorts()).auditLog(...(args as [string | null, string | null, string, string])),
    auditLogQuery: async (...args: any[]) => (await getPorts()).auditLogQuery(...(args as [string])),
  } as unknown as Ports;

  const authRoutes = createAuthRoutes(config, authBackend);

  app.post("/register", authRoutes.register);
  app.post("/unregister", authRoutes.unregister);

  // BaaS dynamic endpoint: call an account's authored function with a user
  // session token (or no token for public functions). This is the surface a
  // static frontend (e.g. ZenBin) calls directly — no account JWT required.
  app.post("/u/:accountId/:fn", async (req: any, res: any) => {
    const timer = startTimer("baas.function");
    try {
      const ports = await getPorts();
      const { accountId, fn } = req.params;
      const got = await ports.appGetFunction(accountId, fn);
      if (!got.found || !got.fn) {
        timer.end({ notFound: true });
        return res.status(404).json({ error: "FUNCTION_NOT_FOUND", message: `Function ${fn} not found for account ${accountId}` });
      }

      let user: { id: string; accountId: string } | null = null;
      if (!got.fn.public) {
        const cred = req.headers.authorization && String(req.headers.authorization).startsWith("Bearer ")
          ? String(req.headers.authorization).slice(7)
          : undefined;
        const ident = await createOpaqueTokenResolver(ports).resolve(accountId, cred);
        if (!ident) {
          timer.end({ authFailed: true });
          recordAuthFailure();
          return res.status(401).json({ error: "AUTH_REQUIRED", message: "A valid session token is required for this function" });
        }
        user = { id: ident.userId, accountId };
      }

      const ctx = buildFunctionContext(ports, accountId, user, req.body);
      try {
        const result = await functionRuntime.exec(got.fn.body, ctx, config.functionTimeoutMs);
        timer.end({ accountId, fn, public: got.fn.public, ok: true });
        return res.status(200).json({ ok: true, result });
      } catch (e) {
        const msg = (e as Error).message || "function failed";
        timer.end({ accountId, fn, error: true });
        logger.warn("BaaS function failed", { accountId, fn, message: config.trustMode === "hosted" ? "function error" : msg });
        // In hosted mode do not echo internal error detail to the public surface.
        return res.status(500).json({ error: "FUNCTION_FAILED", message: config.trustMode === "hosted" ? "function execution failed" : msg });
      }
    } catch (e) {
      const err = e as Error;
      timer.end({ error: true });
      logger.error("BaaS endpoint error", { error: err.message, stack: err.stack });
      return res.status(500).json({ error: "INTERNAL_ERROR", message: "internal error" });
    }
  });

  // Protected MCP endpoint
  app.post("/mcp", async (req: any, res: any) => {
    const timer = startTimer("mcp.request");

    if (config.trustMode === "hosted") {
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

  return app;
}
import type { Config } from "./config.js";
import { PortError } from "./errors.js";
import type { Ports } from "./ports/types.js";
import { validateAdminJwt, parsePorts, extractBearer } from "./auth.js";
import { logger, startTimer } from "./logger.js";

export function createAuthRoutes(config: Config, backend: Ports) {
  return {
    register: async (req: any, res: any) => {
      const timer = startTimer("auth.register");
      if (!config.admin) {
        return res.status(503).json({ error: "admin_not_configured", message: "Admin trust root not configured" });
      }

      let authCtx;
      try {
        const token = extractBearer(req.headers.authorization);
        authCtx = await validateAdminJwt(token, config);
      } catch (e) {
        const err = e as PortError;
        return res.status(err.status || 401).json({ error: err.code, message: err.message });
      }

      const { accountId, name, issuer, audience, publicJwk, jwksUrl, ports } = req.body || {};

      if (!accountId || !issuer || !audience) {
        return res.status(400).json({ error: "VALIDATION_ERROR", message: "accountId, issuer, and audience are required" });
      }

      if (!publicJwk && !jwksUrl) {
        return res.status(400).json({ error: "VALIDATION_ERROR", message: "Either publicJwk or jwksUrl is required" });
      }

      if (publicJwk && jwksUrl) {
        return res.status(400).json({ error: "VALIDATION_ERROR", message: "Provide either publicJwk or jwksUrl, not both" });
      }

      if (!ports || typeof ports !== "object") {
        return res.status(400).json({ error: "VALIDATION_ERROR", message: "ports object is required" });
      }

      let scopes: string[];
      try {
        scopes = parsePorts(ports);
      } catch (e) {
        const err = e as PortError;
        return res.status(err.status).json({ error: err.code, message: err.message });
      }

      try {
        logger.info("registering account", { accountId, issuer });
        await backend.accountCreate(accountId, name || accountId, issuer, audience, scopes);

        if (publicJwk) {
          const kid = (publicJwk as any).kid || "default";
          await backend.accountAddKey(accountId, kid, publicJwk);
        }

        if (jwksUrl) {
          await backend.accountAddJwksUrl(accountId, jwksUrl);
        }

        await backend.auditLog("admin", accountId, "register", "success", { scopes });
        timer.end({ accountId, scopes });
        logger.info("account registered", { accountId, scopes });

        return res.status(201).json({
          ok: true,
          accountId,
          issuer,
          audience,
          scopes,
          status: "active",
        });
      } catch (e) {
        const err = e as PortError;
        await backend.auditLog("admin", accountId, "register", "failure", { error: err.message });
        timer.end({ accountId, error: true });
        logger.error("account registration failed", { accountId, error: err.message });
        return res.status(err.status || 500).json({ error: err.code, message: err.message });
      }
    },

    unregister: async (req: any, res: any) => {
      const timer = startTimer("auth.unregister");
      if (!config.admin) {
        return res.status(503).json({ error: "admin_not_configured", message: "Admin trust root not configured" });
      }

      let authCtx;
      try {
        const token = extractBearer(req.headers.authorization);
        authCtx = await validateAdminJwt(token, config);
      } catch (e) {
        const err = e as PortError;
        return res.status(err.status || 401).json({ error: err.code, message: err.message });
      }

      const { accountId, confirm } = req.body || {};

      if (!accountId) {
        return res.status(400).json({ error: "VALIDATION_ERROR", message: "accountId is required" });
      }

      if (!confirm) {
        return res.status(400).json({ error: "CONFIRM_REQUIRED", message: "Pass confirm: true to unregister" });
      }

      const existing = await backend.accountGet(accountId);
      if (!existing) {
        return res.status(404).json({ error: "ACCOUNT_NOT_FOUND", message: `Account ${accountId} not found` });
      }

      const result = await backend.accountDisable(accountId);
      await backend.auditLog("admin", accountId, "unregister", "success");
      timer.end({ accountId });
      logger.info("account unregistered", { accountId });

      return res.status(200).json({
        ok: result.ok,
        accountId,
        status: "disabled",
      });
    },
  };
}
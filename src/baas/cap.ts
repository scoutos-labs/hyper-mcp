import { SignJWT, jwtVerify } from "jose";
import { createSecretKey, randomBytes } from "node:crypto";
import type { Ports } from "../ports/types.js";

/**
 * Internal capability auth: a short-lived HS256 JWT binding
 * `{ accountId, userId, exp }`, signed with a per-process random secret. The
 * Daytona sandbox receives only this token + the cap URL; it never sees DB
 * credentials. The `/_internal/cap/:op` endpoints verify it and enforce
 * user-scoping server-side, identical to the prototype `ctx`.
 */

export type CapContext = { accountId: string; userId: string | null };

export function createCapSecret(): string {
  return randomBytes(32).toString("hex");
}

function key(secret: string) {
  return createSecretKey(Buffer.from(secret, "hex"));
}

export async function signCapToken(secret: string, ctx: CapContext, ttlMs: number): Promise<string> {
  return new SignJWT({ accountId: ctx.accountId, userId: ctx.userId ?? null })
    .setProtectedHeader({ alg: "HS256" })
    .setIssuer("hyper-mcp-cap")
    .setExpirationTime(`${Math.round(ttlMs / 1000)}s`)
    .sign(key(secret));
}

export async function verifyCapToken(secret: string, token: string): Promise<CapContext> {
  const { payload } = await jwtVerify(token, key(secret), { issuer: "hyper-mcp-cap" });
  const accountId = payload.accountId as string | undefined;
  if (typeof accountId !== "string" || !accountId) throw new Error("cap token missing accountId");
  const userId = payload.userId as string | null | undefined;
  return { accountId, userId: typeof userId === "string" ? userId : null };
}

/**
 * Build the Express handler for `POST /_internal/cap/:op`. Verifies the cap
 * token, then dispatches the op to the Ports backend scoped by the token's
 * accountId (and userId for db/kv). Mirrors the prototype ctx capability surface.
 */
export function createCapabilityHandler(ports: Ports, secret: string) {
  return async (req: any, res: any) => {
    const op = req.params.op as string;
    const auth = req.headers.authorization;
    const token = auth && String(auth).startsWith("Bearer ") ? String(auth).slice(7) : undefined;
    if (!token) return res.status(401).json({ error: "CAP_AUTH_REQUIRED" });
    let ctx: CapContext;
    try { ctx = await verifyCapToken(secret, token); } catch { return res.status(401).json({ error: "CAP_AUTH_INVALID" }); }

    const aid = ctx.accountId;
    const requireUser = (): string => {
      if (!ctx.userId) throw new Error("this operation requires an authenticated user");
      return ctx.userId;
    };
    const b = req.body ?? {};

    try {
      switch (op) {
        case "db_get": return res.json(await ports.appDataGet(aid, requireUser(), b.collection, b.id));
        case "db_find": return res.json(await ports.appDataFind(aid, requireUser(), b.collection, b.options));
        case "db_create": return res.json(await ports.appDataCreate(aid, requireUser(), b.collection, b.document));
        case "db_update": return res.json(await ports.appDataUpdate(aid, requireUser(), b.collection, b.id, b.patch));
        case "db_delete": return res.json(await ports.appDataDelete(aid, requireUser(), b.collection, b.id));
        case "db_count": return res.json(await ports.appDataCount(aid, requireUser(), b.collection, b.filter));
        case "kv_set": { const u = requireUser(); await ports.cacheSet(aid, `kv:${u}:${b.key}`, b.value, b.ttlSeconds); return res.json({ ok: true }); }
        case "kv_get": { const u = requireUser(); return res.json(await ports.cacheGet(aid, `kv:${u}:${b.key}`)); }
        case "kv_delete": { const u = requireUser(); return res.json(await ports.cacheDelete(aid, `kv:${u}:${b.key}`)); }
        case "auth_createUser": return res.json(await ports.authCreateUser(aid, b.input));
        case "auth_getUser": return res.json(await ports.authGetUser(aid, b.userId));
        case "auth_findUsers": return res.json(await ports.authFindUsers(aid, b.query));
        case "auth_setPassword": return res.json(await ports.authSetPassword(aid, b.userId, b.password));
        case "auth_verifyPassword": return res.json(await ports.authVerifyPassword(aid, b.userId, b.password));
        case "auth_createSession": return res.json(await ports.authCreateSession(aid, b.userId, b.options));
        default: return res.status(404).json({ error: "CAP_UNKNOWN_OP" });
      }
    } catch (e) {
      return res.status(400).json({ error: "CAP_OP_FAILED", message: (e as Error).message });
    }
  };
}

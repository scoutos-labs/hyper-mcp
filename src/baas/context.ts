import type { FunctionContext, UserScopedDb, UserScopedKv, FunctionAuth } from "./types.js";
import type { Ports } from "../ports/types.js";

/**
 * Build the capability context handed to an account's function. Every data
 * access is scoped to `user.id` (prototype RLS): the wrapper bakes the userId
 * into every call so a function can never address another user's rows.
 *
 * `auth` and `kv` are scoped to the route's `accountId`. Public functions get
 * `user = null`; their `ctx.db` and `ctx.kv` throw on use (public functions
 * are for signup/login and operate via `ctx.auth` only).
 */
export function buildFunctionContext(
  ports: Ports,
  accountId: string | undefined,
  user: { id: string; accountId: string } | null,
  body: unknown,
): FunctionContext {
  const requireUser = (): string => {
    if (!user) throw new Error("ctx.db/ctx.kv require an authenticated user; this function is public");
    return user.id;
  };

  const db: UserScopedDb = {
    get: (collection, id) => ports.appDataGet(accountId, requireUser(), collection, id),
    find: (collection, options) => ports.appDataFind(accountId, requireUser(), collection, options),
    create: (collection, document) => ports.appDataCreate(accountId, requireUser(), collection, document),
    update: (collection, id, patch) => ports.appDataUpdate(accountId, requireUser(), collection, id, patch),
    delete: (collection, id) => ports.appDataDelete(accountId, requireUser(), collection, id),
    count: (collection, filter) => ports.appDataCount(accountId, requireUser(), collection, filter),
  };

  const auth: FunctionAuth = {
    createUser: (input) => ports.authCreateUser(accountId, input),
    getUser: (userId) => ports.authGetUser(accountId, userId),
    findUsers: (query) => ports.authFindUsers(accountId, query),
    setPassword: (userId, password) => ports.authSetPassword(accountId, userId, password),
    verifyPassword: (userId, password) => ports.authVerifyPassword(accountId, userId, password),
    createSession: (userId, options) => ports.authCreateSession(accountId, userId, options),
  };

  const kv: UserScopedKv = {
    set: async (key, value, ttlSeconds) => {
      const uid = requireUser();
      await ports.cacheSet(accountId, `kv:${uid}:${key}`, value, ttlSeconds);
      return { ok: true };
    },
    get: async (key) => {
      const uid = requireUser();
      const r = await ports.cacheGet(accountId, `kv:${uid}:${key}`);
      return { value: r.value, found: r.found };
    },
    delete: async (key) => {
      const uid = requireUser();
      const r = await ports.cacheDelete(accountId, `kv:${uid}:${key}`);
      return { deleted: r.deleted };
    },
  };

  return { user, body, db, auth, kv };
}
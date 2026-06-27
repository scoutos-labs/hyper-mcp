import type { Ports } from "../ports/types.js";

/**
 * Resolves a request credential to an end-user identity at the BaaS boundary.
 * This is the adapter contract that lets a static frontend (e.g. a ZenBin page)
 * call hyper-mcp directly with a USER credential — no account JWT required.
 *
 * Prototype impl: {@link OpaqueTokenResolver} verifies an auth-port session token.
 * Prod impl (contract-only here): OIDC JWT verified via JWKS, reusing the
 * multi-provider admin trust `jose` machinery.
 */
export interface IdentityResolver {
  /**
   * @returns `{ accountId, userId }` for a valid credential, or `null` when the
   * credential is absent/invalid/expired. Must NOT throw on auth failures —
   * return null so the endpoint can map to a clean 401 without leaking which
   * check failed.
   */
  resolve(accountId: string, credential: string | undefined): Promise<{ accountId: string; userId: string } | null>;
}

/**
 * The function execution sandbox. The account owner authors JS functions; the
 * runtime runs them with a scoped {@link FunctionContext} and returns JSON.
 *
 * Prototype impl: {@link VmFunctionRuntime} (node:vm restricted context) —
 * TRUSTED DEV CODE ONLY; NOT A SECURITY BARRIER. Untrusted/multi-tenant code
 * must use the Daytona FunctionRuntime (prod, contract-only here).
 */
export interface FunctionRuntime {
  /** Stable impl name, surfaced in startup logs (e.g. `vm-trusted-prototype`). */
  readonly name: string;
  /**
   * Execute `source` (a JS expression evaluating to `async (ctx) => result`)
   * with the given context. Returns the JSON-serializable result.
   * Throws on eval error, non-serializable result, sandbox violation, or timeout.
   */
  exec(source: string, ctx: FunctionContext, timeoutMs: number): Promise<unknown>;
}

/**
 * The capability surface handed to an account's function. Every data access is
 * auto-scoped to `user.id` (prototype RLS); the function cannot address another
 * user. `auth` and `kv` are scoped to `accountId`.
 */
export interface FunctionContext {
  /** The end user, or null for public functions (signup/login). */
  user: { id: string; accountId: string } | null;
  /** The parsed HTTP request body. */
  body: unknown;
  /** User-scoped data store (RLS). */
  db: UserScopedDb;
  /** Account-scoped auth primitives (server-side trust). */
  auth: FunctionAuth;
  /** Per-user JSON key-value store. */
  kv: UserScopedKv;
}

export interface UserScopedDb {
  get(collection: string, id: string): Promise<{ document: unknown | null; found: boolean }>;
  find(collection: string, options?: { filter?: Record<string, unknown>; limit?: number; skip?: number }): Promise<{ documents: unknown[]; total: number }>;
  create(collection: string, document: Record<string, unknown>): Promise<{ ok: boolean; id: string }>;
  update(collection: string, id: string, patch: Record<string, unknown>): Promise<{ ok: boolean; matchedCount: number }>;
  delete(collection: string, id: string): Promise<{ deleted: boolean }>;
  count(collection: string, filter?: Record<string, unknown>): Promise<{ count: number }>;
}

export interface UserScopedKv {
  set(key: string, value: unknown, ttlSeconds?: number): Promise<{ ok: boolean }>;
  get(key: string): Promise<{ value: unknown; found: boolean }>;
  delete(key: string): Promise<{ deleted: boolean }>;
}

export interface FunctionAuth {
  createUser(input: { email?: string | null; username?: string | null; phone?: string | null; attributes?: Record<string, unknown> }): Promise<{ ok: boolean; userId: string }>;
  getUser(userId: string): Promise<{ user: unknown | null; found: boolean }>;
  findUsers(query: { email?: string; username?: string }): Promise<{ users: unknown[] }>;
  setPassword(userId: string, password: string): Promise<{ ok: boolean; userId: string }>;
  verifyPassword(userId: string, password: string): Promise<{ valid: boolean }>;
  createSession(userId: string, options?: { ttlSeconds?: number }): Promise<{ token: string; userId: string; expiresAt: string }>;
}

export type BaaSFactory = (ports: Ports) => { resolver: IdentityResolver; runtime: FunctionRuntime };
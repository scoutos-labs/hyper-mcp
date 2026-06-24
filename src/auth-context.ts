import { AsyncLocalStorage } from "node:async_hooks";
import type { AuthContext } from "./auth.js";

/**
 * Request-scoped storage for auth context.
 *
 * The MCP SDK's stateless transport doesn't pass the Express request
 * object through to tool handlers. AsyncLocalStorage bridges this gap:
 * the HTTP middleware sets the auth context at the start of the request,
 * and tool handlers read it during execution.
 */
const authContextStorage = new AsyncLocalStorage<AuthContext | undefined>();

export function runWithAuth<T>(authCtx: AuthContext | undefined, fn: () => Promise<T>): Promise<T> {
  return authContextStorage.run(authCtx, fn);
}

export function getAuthContext(): AuthContext | undefined {
  return authContextStorage.getStore();
}
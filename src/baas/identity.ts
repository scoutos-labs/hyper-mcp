import type { IdentityResolver } from "./types.js";
import type { Ports } from "../ports/types.js";

/**
 * Prototype IdentityResolver: verifies an opaque session token issued by the
 * auth port (`auth_create_session`). The token is looked up by hashing it and
 * matching `auth_sessions` for the route's account; expired/revoked tokens are
 * invalid.
 *
 * Prod adapter (contract-only): OIDC JWT verified via JWKS, reusing the
 * multi-provider admin trust `jose` machinery.
 */
export function createOpaqueTokenResolver(ports: Ports): IdentityResolver {
  return {
    async resolve(accountId, credential) {
      if (!credential) return null;
      try {
        const r = await ports.authVerifySession(accountId, credential);
        if (!r.valid || !r.userId) return null;
        return { accountId, userId: r.userId };
      } catch {
        // Never throw on auth failure — return null so the endpoint maps to a
        // clean 401 without leaking which check failed.
        return null;
      }
    },
  };
}
import { jwtVerify, createRemoteJWKSet } from "jose";
import type { IdentityResolver } from "./types.js";
import type { OidcProvider } from "../config.js";

/**
 * Prod IdentityResolver: verifies an OIDC JWT (Clerk/AuthKit/Auth0/custom) at
 * the BaaS boundary against the provider's JWKS, and resolves it to
 * `{ accountId, userId }`. Reuses the `jose` machinery from the multi-provider
 * admin trust — the boundary gets the same JWKS-by-issuer model.
 *
 * The unverified `iss` only routes provider selection; signature/aud/exp are
 * enforced by `jwtVerify`. The provider's `accountId` binds an issuer to the
 * hyper-mcp account whose functions those end users may call, and must match the
 * route's `:accountId`. The verified `sub` becomes the `userId` (the row key for
 * `ctx.db`).
 *
 * No JWT is stored; no user row is auto-provisioned — `sub` is a stable user id
 * and `app_data` is keyed by `(account_id, user_id)`, so `ctx.db` works directly.
 */
export function createOidcIdentityResolver(providers: OidcProvider[]): IdentityResolver {
  const keySets = new Map<string, ReturnType<typeof createRemoteJWKSet>>();
  const getKeySet = (p: OidcProvider) => {
    let ks = keySets.get(p.issuer);
    if (!ks) { ks = createRemoteJWKSet(new URL(p.jwksUrl), { cooldownDuration: 300_000, cacheMaxAge: 300_000 }); keySets.set(p.issuer, ks); }
    return ks;
  };

  return {
    async resolve(routeAccountId, credential) {
      if (!credential) return null;
      // Decode unverified iss for provider routing only. Never trust identity
      // fields from this payload; use the payload returned by jwtVerify below.
      let iss: string | undefined;
      try {
        const parts = credential.split(".");
        if (parts.length !== 3) return null;
        const payload = JSON.parse(Buffer.from(parts[1], "base64url").toString("utf8"));
        iss = typeof payload.iss === "string" ? payload.iss : undefined;
      } catch { return null; }
      if (!iss) return null;

      const provider = providers.find((p) => p.issuer === iss);
      if (!provider) return null;
      if (provider.accountId !== routeAccountId) return null; // issuer not bound to this account

      try {
        const { payload } = await jwtVerify(credential, getKeySet(provider), { issuer: provider.issuer, audience: provider.audience });
        const sub = typeof payload.sub === "string" ? payload.sub : undefined;
        if (!sub) return null;
        return { accountId: provider.accountId, userId: sub };
      } catch { return null; }
    },
  };
}

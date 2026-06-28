import type { Config } from "../config.js";
import type { Ports } from "../ports/types.js";
import type { IdentityResolver, FunctionRuntime } from "./types.js";
import { createOpaqueTokenResolver } from "./identity.js";
import { createOidcIdentityResolver } from "./identity-oidc.js";
import { createVmFunctionRuntime } from "./runtime.js";
import { createDaytonaFunctionRuntime } from "./runtime-daytona.js";

/**
 * Select the boundary IdentityResolver from config.
 * - opaque (default): verifies an auth-port session token.
 * - oidc: verifies an OIDC JWT via the configured providers' JWKS.
 */
export function createIdentityResolver(config: Config, getPorts: () => Promise<Ports>): IdentityResolver {
  if (config.baasIdentity === "oidc") return createOidcIdentityResolver(config.baasOidcProviders);
  return createOpaqueTokenResolver(getPorts);
}

/** Select the FunctionRuntime from config. vm = trusted-prototype; daytona = prod. */
export function createFunctionRuntime(config: Config): FunctionRuntime {
  if (config.baasRuntime === "daytona") return createDaytonaFunctionRuntime(config);
  return createVmFunctionRuntime();
}

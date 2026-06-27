import type { Config } from "../config.js";
import type { Ports } from "./types.js";
import { PortError } from "../errors.js";

export type BackendType = "pglite" | "scoutos" | "memory";

let cachedPorts: Ports | undefined;

export async function createPorts(config: Config): Promise<Ports> {
  if (cachedPorts) return cachedPorts;

  const backend = (config.backend || "pglite") as BackendType;

  switch (backend) {
    case "pglite": {
      const { PgliteBackend } = await import("../pglite-backend.js");
      const instance = new PgliteBackend(config.pgDir, config.limits, config.authSessionTtlSeconds);
      cachedPorts = instance as unknown as Ports;
      return cachedPorts;
    }
    case "scoutos":
      // Future: thin HTTP clients for ScoutOS /_ports API
      throw new PortError("BACKEND_NOT_IMPLEMENTED", "ScoutOS remote adapter not yet implemented", 501);
    case "memory":
      // Future: in-memory adapter (PGLite with dir:null already works for this)
      throw new PortError("BACKEND_NOT_IMPLEMENTED", "Memory adapter not yet implemented", 501);
    default:
      throw new PortError("UNKNOWN_BACKEND", `Unknown backend: ${backend}. Use pglite, scoutos, or memory.`, 400);
  }
}

export async function closePorts(): Promise<void> {
  if (cachedPorts?.close) {
    await cachedPorts.close();
  }
  cachedPorts = undefined;
}
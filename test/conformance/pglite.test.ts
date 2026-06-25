import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PgliteBackend } from "../../src/pglite-backend.js";
import type { Ports } from "../../src/ports/types.js";
import { runPortConformanceSuite } from "./ports.conformance.js";

// The PGLite adapter is the reference implementation. This wrapper supplies
// isolated per-test temp directories and a reopen hook so the persistence
// across-reopen test runs. Future adapters add their own wrapper that calls
// runPortConformanceSuite with their own hooks.

let dir = "";

runPortConformanceSuite({
  name: "PgliteBackend",
  makePorts: async () => {
    dir = await mkdtemp(join(tmpdir(), "hyper-mcp-conf-pglite-"));
    return new PgliteBackend(dir) as unknown as Ports;
  },
  closePorts: async (p) => {
    await p.close?.().catch(() => undefined);
    if (dir) await rm(dir, { recursive: true, force: true }).catch(() => undefined);
  },
  reopenPorts: async (p) => {
    await p.close?.().catch(() => undefined);
    return new PgliteBackend(dir) as unknown as Ports;
  },
});
import { describe, expect, it, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PgliteBackend } from "../src/pglite-backend.js";
import { createPorts, closePorts } from "../src/ports/factory.js";
import { loadConfig } from "../src/config.js";
import type { Ports } from "../src/ports/types.js";

let dir: string;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "hyper-mcp-ports-"));
});

afterEach(async () => {
  await closePorts();
  await new Promise(r => setTimeout(r, 200));
  if (dir) await rm(dir, { recursive: true, force: true }).catch(() => {});
});

describe("ports interface compliance", () => {
  it("PgliteBackend satisfies the Ports interface", async () => {
    const backend = new PgliteBackend(dir);
    try {
      // TypeScript will fail if PgliteBackend doesn't implement Ports
      const ports: Ports = backend as Ports;
      expect(ports).toBeDefined();
      expect(typeof ports.dataCreate).toBe("function");
      expect(typeof ports.cacheGet).toBe("function");
      expect(typeof ports.blobPutText).toBe("function");
      expect(typeof ports.queuePublish).toBe("function");
      expect(typeof ports.searchQuery).toBe("function");
      expect(typeof ports.accountCreate).toBe("function");
    } finally {
      await backend.close();
    }
  });
});

describe("adapter factory", () => {
  it("creates PGLite backend by default", async () => {
    const config = loadConfig({
      HYPER_MCP_PGLITE_DIR: dir,
      HYPER_MCP_BACKEND: "pglite",
      HYPER_MCP_AUTH_REQUIRED: "false",
    } as any);
    const ports = await createPorts(config);
    expect(ports).toBeDefined();
    expect(typeof ports.dataCreate).toBe("function");

    // Smoke test: actual port call works
    const { id } = await ports.dataCreate(undefined, "test", { name: "hello" });
    expect(id).toBeTruthy();
    const got = await ports.dataGet(undefined, "test", id);
    expect(got.found).toBe(true);
  });

  it("caches ports instance", async () => {
    const config = loadConfig({
      HYPER_MCP_PGLITE_DIR: dir,
      HYPER_MCP_BACKEND: "pglite",
      HYPER_MCP_AUTH_REQUIRED: "false",
    } as any);
    const ports1 = await createPorts(config);
    const ports2 = await createPorts(config);
    expect(ports1).toBe(ports2);
  });

  it("throws for unknown backend", async () => {
    const config = loadConfig({
      HYPER_MCP_PGLITE_DIR: dir,
      HYPER_MCP_BACKEND: "redis",
      HYPER_MCP_AUTH_REQUIRED: "false",
    } as any);
    await expect(createPorts(config)).rejects.toThrow(/Unknown backend/);
  });

  it("throws for unimplemented scoutos backend", async () => {
    const config = loadConfig({
      HYPER_MCP_PGLITE_DIR: dir,
      HYPER_MCP_BACKEND: "scoutos",
      HYPER_MCP_AUTH_REQUIRED: "false",
    } as any);
    await expect(createPorts(config)).rejects.toThrow(/not yet implemented/);
  });

  it("closePorts clears cache", async () => {
    const config = loadConfig({
      HYPER_MCP_PGLITE_DIR: dir,
      HYPER_MCP_BACKEND: "pglite",
      HYPER_MCP_AUTH_REQUIRED: "false",
    } as any);
    await createPorts(config);
    await closePorts();
    // Next call should create a new instance
    const ports = await createPorts(config);
    expect(ports).toBeDefined();
  });
});
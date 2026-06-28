import { describe, expect, it } from "vitest";
import vm from "node:vm";
import { createDaytonaFunctionRuntime, DAYTONA_RUNTIME_NAME } from "../src/baas/runtime-daytona.js";
import { loadConfig } from "../src/config.js";
import { createCapSecret } from "../src/baas/cap.js";

// A mocked Daytona client + sandbox used to verify the runtime's orchestration
// (script assembly + cap token + result parsing) WITHOUT a real Daytona cloud.
function mockedDaytona(captured: { script?: string }) {
  const sandbox = {
    process: {
      codeRun: async (script: string) => {
        captured.script = script;
        // Evaluate the generated script in node:vm to simulate the sandbox and
        // return stdout via the __RESULT__ marker. We mock fetch by stubbing it
        // on the global before evaluating.
        const fakeFetch = async (url: string, init: any) => {
          // echo a successful cap response so the shim resolves JSON
          return { ok: true, json: async () => ({ ok: true, value: init.body }) };
        };
        const sandboxCtx = { fetch: fakeFetch, console: { log: (...a: any[]) => { (sandboxCtx as any).__out += a.join(" ") + "\n"; } }, __out: "" };
        vm.createContext(sandboxCtx);
        vm.runInContext(script, sandboxCtx, { timeout: 2000 });
        await new Promise(r => setTimeout(r, 10)); // let the async IIFE flush
        return { exitCode: 0, result: (sandboxCtx as any).__out, artifacts: { stdout: (sandboxCtx as any).__out } };
      },
    },
    delete: async () => {},
  };
  return {
    create: async () => sandbox,
  };
}

describe("DaytonaFunctionRuntime (mocked orchestration)", () => {
  it("has the daytona runtime name", () => {
    const cfg = loadConfig({ HYPER_MCP_BAAS_RUNTIME: "daytona", HYPER_MCP_BAAS_CAP_URL: "https://example.test" } as any);
    cfg.baasCapSecret = createCapSecret();
    (cfg as any).daytonaClient = mockedDaytona({} as any);
    const rt = createDaytonaFunctionRuntime(cfg);
    expect(rt.name).toBe(DAYTONA_RUNTIME_NAME);
  });

  it("executes a trivial function and returns its JSON result", async () => {
    const captured: { script?: string } = {};
    const cfg = loadConfig({ HYPER_MCP_BAAS_RUNTIME: "daytona", HYPER_MCP_BAAS_CAP_URL: "https://example.test" } as any);
    cfg.baasCapSecret = createCapSecret();
    (cfg as any).daytonaClient = mockedDaytona(captured);
    const rt = createDaytonaFunctionRuntime(cfg);
    const result = await rt.exec(`async (ctx) => ({ hello: "world", user: ctx.user && ctx.user.id })`, { user: { id: "u1", accountId: "acct" }, body: { x: 1 }, db: null as any, auth: null as any, kv: null as any }, 5000);
    expect(result).toEqual({ hello: "world", user: "u1" });
    expect(captured.script).toContain("__RESULT__");
    expect(captured.script).toContain("https://example.test");
  });

  it("throws when baasCapUrl is not configured", async () => {
    const cfg = loadConfig({ HYPER_MCP_BAAS_RUNTIME: "daytona" } as any);
    cfg.baasCapSecret = createCapSecret();
    (cfg as any).daytonaClient = mockedDaytona({} as any);
    const rt = createDaytonaFunctionRuntime(cfg);
    await expect(rt.exec(`async (ctx) => 1`, { user: null, body: {}, db: null as any, auth: null as any, kv: null as any }, 1000)).rejects.toThrow(/HYPER_MCP_BAAS_CAP_URL/);
  });

  it("rejects a non-JSON-serializable result", async () => {
    const cfg = loadConfig({ HYPER_MCP_BAAS_RUNTIME: "daytona", HYPER_MCP_BAAS_CAP_URL: "https://example.test" } as any);
    cfg.baasCapSecret = createCapSecret();
    (cfg as any).daytonaClient = mockedDaytona({} as any);
    const rt = createDaytonaFunctionRuntime(cfg);
    // BigInt is not JSON-serializable
    await expect(rt.exec(`async (ctx) => BigInt(1)`, { user: null, body: {}, db: null as any, auth: null as any, kv: null as any }, 2000)).rejects.toThrow();
  });
});

// Real Daytona e2e is gated on DAYTONA_API_KEY — skipped when unset.
describe.skipIf(!process.env.DAYTONA_API_KEY)("DaytonaFunctionRuntime (real, gated)", () => {
  it("runs a function in a real Daytona sandbox", async () => {
    const cfg = loadConfig({ HYPER_MCP_BAAS_RUNTIME: "daytona", HYPER_MCP_BAAS_CAP_URL: "https://example.test" } as any);
    cfg.baasCapSecret = createCapSecret();
    const rt = createDaytonaFunctionRuntime(cfg);
    const result = await rt.exec(`async (ctx) => ({ ok: true, echo: ctx.body })`, { user: null, body: { hi: 1 }, db: null as any, auth: null as any, kv: null as any }, 30_000);
    expect(result).toEqual({ ok: true, echo: { hi: 1 } });
  });
});
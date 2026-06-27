import vm from "node:vm";
import type { FunctionRuntime, FunctionContext } from "./types.js";

export const VM_RUNTIME_NAME = "vm-trusted-prototype";

/**
 * ⚠️ PROTOTYPE ONLY — NOT A SECURITY BARRIER.
 *
 * `node:vm` with a restricted context is adequate for code the account OWNER
 * authors (local/dev, trusted). It is escape-able by sophisticated code (host
 * object prototype traversal). For untrusted or multi-tenant code, use the
 * Daytona `FunctionRuntime` (prod adapter, contract-only in this cycle).
 *
 * The sandbox global exposes ONLY: ctx, JSON, Math, Date, Promise, console.
 * There is no `require`, `process`, `globalThis`, `Buffer`, `fetch`, timers,
 * or filesystem. The function source must evaluate to a function
 * (typically `async (ctx) => result`).
 */
export function createVmFunctionRuntime(): FunctionRuntime {
  return {
    name: VM_RUNTIME_NAME,
    async exec(source, ctx: FunctionContext, timeoutMs: number): Promise<unknown> {
      const sandbox = Object.freeze({
        ctx,
        JSON,
        Math,
        Date,
        Promise,
        console: { log: () => {}, error: () => {}, warn: () => {}, info: () => {} },
      });
      vm.createContext(sandbox, { name: "hyper-mcp-function" });

      let handler: unknown;
      try {
        const script = new vm.Script(`(${source})`, { filename: "app-function.js" });
        handler = script.runInContext(sandbox, { timeout: timeoutMs });
      } catch (e) {
        throw new Error(`function compile/eval failed: ${(e as Error).message}`);
      }
      if (typeof handler !== "function") {
        throw new Error("function source must evaluate to a function");
      }

      let timer: NodeJS.Timeout | undefined;
      const timeout = new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error(`function exceeded ${timeoutMs}ms timeout`)), timeoutMs);
      });
      try {
        const result = await Promise.race([
          Promise.resolve().then(() => (handler as (c: FunctionContext) => unknown)(ctx)),
          timeout,
        ]);
        // Reject non-JSON-serializable results (cyclic, BigInt, symbols, functions).
        try {
          JSON.stringify(result);
        } catch {
          throw new Error("function returned a non-JSON-serializable value");
        }
        return result;
      } finally {
        if (timer) clearTimeout(timer);
      }
    },
  };
}
import { Daytona, CodeLanguage } from "@daytona/sdk";
import type { FunctionRuntime, FunctionContext } from "./types.js";
import type { Config } from "../config.js";
import { signCapToken } from "./cap.js";

export const DAYTONA_RUNTIME_NAME = "daytona";

/**
 * Prod FunctionRuntime: executes an account's function in an isolated Daytona
 * sandbox with NO host access. The only egress is a capability RPC back to
 * hyper-mcp (`/_internal/cap/*`) over a short-lived signed cap token. This is
 * the real security barrier the prototype `node:vm` runtime is not.
 *
 * The sandbox runs a self-contained JS script: a generated capability shim
 * (ctx.db/auth/kv via fetch to the cap endpoints) + the user's handler. The
 * result is printed to stdout with a `__RESULT__` marker; errors with
 * `__ERROR__`. hyper-mcp parses stdout and returns the JSON result.
 */
export function createDaytonaFunctionRuntime(config: Config): FunctionRuntime {
  const capUrl = config.baasCapUrl;
  const daytona: any = config.daytonaClient ?? new Daytona();

  return {
    name: DAYTONA_RUNTIME_NAME,
    async exec(source, ctx: FunctionContext, timeoutMs: number): Promise<unknown> {
      if (!capUrl) throw new Error("Daytona runtime requires HYPER_MCP_BAAS_CAP_URL (public base URL for capability callbacks)");
      const ttl = timeoutMs + 5000;
      const capToken = await signCapToken(config.baasCapSecret!, { accountId: ctx.user?.accountId ?? "", userId: ctx.user?.id ?? null }, ttl);

      const ctxPayload = JSON.stringify({ user: ctx.user, body: ctx.body });
      const script = buildSandboxScript(source, ctxPayload, capUrl, capToken);

      const sandbox = await daytona.create({ language: "typescript" }, { timeout: Math.ceil(ttl / 1000) });
      try {
        const resp = await sandbox.process.codeRun(script, { language: CodeLanguage.JAVASCRIPT }, Math.ceil(timeoutMs / 1000));
        const out = resp.result || resp.artifacts?.stdout || "";
        if (resp.exitCode !== 0 && !out.includes("__RESULT__")) {
          throw new Error(`sandbox exited ${resp.exitCode}: ${out.slice(0, 500)}`);
        }
        return parseSandboxOutput(out);
      } finally {
        await sandbox.delete().catch(() => {});
      }
    },
  };
}

/** Build the self-contained sandbox script: capability shim + user handler + result print. */
function buildSandboxScript(userSource: string, ctxPayload: string, capUrl: string, capToken: string): string {
  // The shim defines `ctx` with fetch-based db/auth/kv calling /_internal/cap/*.
  // No process/require/globalThis is referenced; the sandbox image provides fetch.
  return `
const __CAP_URL = ${JSON.stringify(capUrl)};
const __CAP_TOKEN = ${JSON.stringify(capToken)};
async function __cap(op, body) {
  const r = await fetch(__CAP_URL + "/_internal/cap/" + op, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: "Bearer " + __CAP_TOKEN },
    body: JSON.stringify(body ?? {}),
  });
  const j = await r.json();
  if (!r.ok) throw new Error((j && j.message) || ("cap " + op + " failed"));
  return j;
}
const __ctxPayload = ${ctxPayload};
const ctx = {
  user: __ctxPayload.user,
  body: __ctxPayload.body,
  db: {
    get: (c, i) => __cap("db_get", { collection: c, id: i }),
    find: (c, o) => __cap("db_find", { collection: c, options: o }),
    create: (c, d) => __cap("db_create", { collection: c, document: d }),
    update: (c, i, p) => __cap("db_update", { collection: c, id: i, patch: p }),
    delete: (c, i) => __cap("db_delete", { collection: c, id: i }),
    count: (c, f) => __cap("db_count", { collection: c, filter: f }),
  },
  auth: {
    createUser: (i) => __cap("auth_createUser", { input: i }),
    getUser: (u) => __cap("auth_getUser", { userId: u }),
    findUsers: (q) => __cap("auth_findUsers", { query: q }),
    setPassword: (u, p) => __cap("auth_setPassword", { userId: u, password: p }),
    verifyPassword: (u, p) => __cap("auth_verifyPassword", { userId: u, password: p }),
    createSession: (u, o) => __cap("auth_createSession", { userId: u, options: o }),
  },
  kv: {
    set: (k, v, t) => __cap("kv_set", { key: k, value: v, ttlSeconds: t }),
    get: (k) => __cap("kv_get", { key: k }),
    delete: (k) => __cap("kv_delete", { key: k }),
  },
};
(async () => {
  try {
    const __h = (${userSource});
    const __r = await __h(ctx);
    try { JSON.stringify(__r); } catch (e) { throw new Error("function returned a non-JSON-serializable value"); }
    console.log("__RESULT__" + JSON.stringify(__r));
  } catch (e) {
    console.log("__ERROR__" + (e && e.message ? e.message : String(e)));
  }
})();
`;
}

function parseSandboxOutput(out: string): unknown {
  const i = out.lastIndexOf("__RESULT__");
  const j = out.lastIndexOf("__ERROR__");
  if (i > j && i >= 0) {
    return JSON.parse(out.slice(i + "__RESULT__".length).trim());
  }
  if (j >= 0) {
    throw new Error(out.slice(j + "__ERROR__".length).trim());
  }
  throw new Error("sandbox produced no result marker; stdout: " + out.slice(0, 500));
}
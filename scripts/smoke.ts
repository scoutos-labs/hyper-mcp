#!/usr/bin/env tsx

type Target = {
  name: string;
  baseUrl: string;
};

type Health = {
  ok?: boolean;
  service?: string;
  backend?: string;
  persistentDir?: string;
  readOnly?: boolean;
  authRequired?: boolean;
  adminConfigured?: boolean;
  [key: string]: unknown;
};

const DEFAULT_LOCAL_URL = process.env.SMOKE_LOCAL_URL || "http://localhost:3000";
const DEFAULT_RENDER_URL = process.env.SMOKE_RENDER_URL || "https://hyper-mcp.onrender.com";
let timeoutMs = Number(process.env.SMOKE_TIMEOUT_MS || 30_000);

class SmokeError extends Error {}

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new SmokeError(message);
}

function normalizeBaseUrl(input: string) {
  const value = input.trim();
  if (/^https?:\/\//i.test(value)) return value.replace(/\/+$/, "");
  if (value.startsWith("localhost") || value.startsWith("127.0.0.1")) {
    return `http://${value}`.replace(/\/+$/, "");
  }
  return `https://${value}`.replace(/\/+$/, "");
}

function targetNameFromUrl(baseUrl: string) {
  try {
    const url = new URL(baseUrl);
    return url.hostname.replace(/^www\./, "");
  } catch {
    return baseUrl;
  }
}

function parseTargets(argv: string[]): Target[] {
  const targets: Target[] = [];

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];

    if (arg === "--timeout-ms") {
      const next = argv[++i];
      assert(next, "--timeout-ms requires a numeric value");
      timeoutMs = Number(next);
      assert(Number.isFinite(timeoutMs) && timeoutMs > 0, "--timeout-ms must be a positive number");
      continue;
    }

    if (arg === "--local") {
      targets.push({ name: "local", baseUrl: normalizeBaseUrl(DEFAULT_LOCAL_URL) });
      continue;
    }

    if (arg === "--render" || arg === "--prod" || arg === "--production") {
      targets.push({ name: "render", baseUrl: normalizeBaseUrl(DEFAULT_RENDER_URL) });
      continue;
    }

    if (arg === "--help" || arg === "-h") {
      printHelp();
      process.exit(0);
    }

    const baseUrl = normalizeBaseUrl(arg);
    targets.push({ name: targetNameFromUrl(baseUrl), baseUrl });
  }

  return targets.length
    ? targets
    : [
        { name: "local", baseUrl: normalizeBaseUrl(DEFAULT_LOCAL_URL) },
        { name: "render", baseUrl: normalizeBaseUrl(DEFAULT_RENDER_URL) },
      ];
}

function printHelp() {
  console.log(`hyper-mcp smoke test\n\nUsage:\n  npm run smoke                  # local + Render\n  npm run smoke:local            # http://localhost:3000\n  npm run smoke:render           # https://hyper-mcp.onrender.com\n  npm run smoke -- <url> [...]   # custom target(s)\n\nOptions:\n  --local              test $SMOKE_LOCAL_URL or http://localhost:3000\n  --render             test $SMOKE_RENDER_URL or https://hyper-mcp.onrender.com\n  --timeout-ms <ms>    per-request timeout, default $SMOKE_TIMEOUT_MS or 30000\n\nOptional env:\n  SMOKE_ACCOUNT_JWT    if set, also checks authenticated POST /mcp tools/list\n`);
}

function endpoint(target: Target, path: string) {
  return `${target.baseUrl}${path}`;
}

async function request(target: Target, path: string, init: RequestInit = {}) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);

  try {
    return await fetch(endpoint(target, path), {
      ...init,
      signal: controller.signal,
      headers: {
        "user-agent": "hyper-mcp-smoke/0.1",
        ...(init.headers || {}),
      },
    });
  } catch (error) {
    if ((error as Error).name === "AbortError") {
      throw new SmokeError(`request timed out after ${timeoutMs}ms: ${path}`);
    }
    throw error;
  } finally {
    clearTimeout(timeout);
  }
}

async function readJson<T>(res: Response, label: string): Promise<T> {
  const text = await res.text();
  try {
    return JSON.parse(text) as T;
  } catch {
    throw new SmokeError(`${label} returned non-JSON body: ${text.slice(0, 240)}`);
  }
}

async function postJson(target: Target, path: string, body: unknown, token?: string) {
  return request(target, path, {
    method: "POST",
    headers: {
      accept: "application/json, text/event-stream",
      "content-type": "application/json",
      ...(token ? { authorization: `Bearer ${token}` } : {}),
    },
    body: JSON.stringify(body),
  });
}

async function runCheck(name: string, fn: () => Promise<string | void>) {
  try {
    const detail = await fn();
    console.log(`  PASS ${name}${detail ? ` — ${detail}` : ""}`);
    return true;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`  FAIL ${name} — ${message}`);
    return false;
  }
}

async function runTarget(target: Target) {
  console.log(`\nTarget: ${target.name} (${target.baseUrl})`);
  let passed = 0;
  let failed = 0;
  let health: Health | undefined;

  const record = async (name: string, fn: () => Promise<string | void>) => {
    const ok = await runCheck(name, fn);
    if (ok) passed++;
    else failed++;
  };

  await record("GET /health", async () => {
    const res = await request(target, "/health", { headers: { accept: "application/json" } });
    assert(res.status === 200, `expected 200, got ${res.status}`);
    health = await readJson<Health>(res, "/health");
    assert(health.ok === true, "expected ok=true");
    assert(health.service === "hyper-mcp", `expected service=hyper-mcp, got ${String(health.service)}`);
    assert(typeof health.authRequired === "boolean", "expected authRequired boolean");
    assert(typeof health.adminConfigured === "boolean", "expected adminConfigured boolean");
    return `backend=${health.backend}; authRequired=${health.authRequired}; adminConfigured=${health.adminConfigured}`;
  });

  await record("GET /", async () => {
    const res = await request(target, "/", { headers: { accept: "text/html" } });
    assert(res.status === 200, `expected 200, got ${res.status}`);
    const text = await res.text();
    assert(text.includes("hyper-mcp"), "landing page did not include hyper-mcp");
    assert(text.includes("/health"), "landing page did not include /health link/text");
    return "landing page rendered";
  });

  await record("GET /metrics", async () => {
    const res = await request(target, "/metrics", { headers: { accept: "application/json" } });
    assert(res.status === 200, `expected 200, got ${res.status}`);
    const metrics = await readJson<Record<string, unknown>>(res, "/metrics");
    assert(typeof metrics.requests === "number", "expected metrics.requests number");
    assert(typeof metrics.uptimeSeconds === "number", "expected metrics.uptimeSeconds number");
    return `requests=${metrics.requests}; uptime=${metrics.uptimeSeconds}s`;
  });

  await record("GET /mcp method guard", async () => {
    const res = await request(target, "/mcp", { headers: { accept: "application/json" } });
    assert(res.status === 405, `expected 405, got ${res.status}`);
    const json = await readJson<any>(res, "GET /mcp");
    assert(json?.jsonrpc === "2.0", "expected JSON-RPC error response");
    return "GET rejected with JSON-RPC 405";
  });

  await record("POST /register without admin JWT", async () => {
    const res = await postJson(target, "/register", {
      accountId: "smoke-unauthorized",
      issuer: "smoke-unauthorized",
      audience: "hyper-mcp",
      ports: { "data:read": true },
      publicJwk: { kty: "OKP", crv: "Ed25519", x: "not-a-real-key", kid: "smoke" },
    });
    const text = await res.text();
    const expected = health?.adminConfigured ? [401, 403] : [503];
    assert(expected.includes(res.status), `expected ${expected.join(" or ")}, got ${res.status}: ${text.slice(0, 240)}`);
    return health?.adminConfigured ? "admin route requires auth" : "admin route reports admin_not_configured";
  });

  await record("POST /mcp tools/list auth posture", async () => {
    const res = await postJson(target, "/mcp", {
      jsonrpc: "2.0",
      id: "smoke-tools-list",
      method: "tools/list",
      params: {},
    });
    const text = await res.text();

    if (health?.authRequired && health?.adminConfigured) {
      assert(res.status === 401, `expected 401 for unauthenticated MCP, got ${res.status}: ${text.slice(0, 240)}`);
      assert(text.includes("AUTH") || text.includes("auth") || text.includes("MISSING"), "expected auth error body");
      return "unauthenticated MCP rejected";
    }

    if (health?.authRequired && !health?.adminConfigured) {
      assert(res.status === 503, `expected 503 when admin trust root is missing, got ${res.status}: ${text.slice(0, 240)}`);
      assert(text.includes("ADMIN_NOT_CONFIGURED") || text.includes("admin"), "expected admin-not-configured body");
      return "MCP fails closed without admin trust root";
    }

    assert(res.status === 200, `expected 200 for open MCP, got ${res.status}: ${text.slice(0, 240)}`);
    assert(text.includes("jsonrpc") || text.includes("tools") || text.includes("event:"), "expected MCP response body");
    return "open MCP responded to tools/list";
  });

  const accountJwt = process.env.SMOKE_ACCOUNT_JWT || process.env.HYPER_MCP_SMOKE_ACCOUNT_JWT;
  if (accountJwt) {
    await record("POST /mcp tools/list with SMOKE_ACCOUNT_JWT", async () => {
      const res = await postJson(
        target,
        "/mcp",
        { jsonrpc: "2.0", id: "smoke-auth-tools-list", method: "tools/list", params: {} },
        accountJwt,
      );
      const text = await res.text();
      assert(res.status === 200, `expected 200, got ${res.status}: ${text.slice(0, 240)}`);
      assert(text.includes("tools") || text.includes("result") || text.includes("event:"), "expected tools/list response");
      return "authenticated MCP responded";
    });
  }

  console.log(`  Summary: ${passed} passed, ${failed} failed`);
  return { passed, failed };
}

const targets = parseTargets(process.argv.slice(2));
let totalPassed = 0;
let totalFailed = 0;

for (const target of targets) {
  const result = await runTarget(target);
  totalPassed += result.passed;
  totalFailed += result.failed;
}

console.log(`\nSmoke result: ${totalPassed} passed, ${totalFailed} failed`);
process.exitCode = totalFailed > 0 ? 1 : 0;

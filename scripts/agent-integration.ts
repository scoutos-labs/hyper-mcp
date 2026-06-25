#!/usr/bin/env tsx
// Live agent-integration verifier for hyper-mcp.
//
// Proves that a real agent using the official MCP client SDK can authenticate
// against a hyper-mcp instance, run the initialize handshake, list tools, and
// successfully call a representative write+read tool on each of the five ports,
// plus tenant isolation between two agents.
//
// Two modes:
//   --local            Boot an in-process hyper-mcp (generated admin keys,
//                      temp PGLite dir) and run the flow against it. Fully
//                      self-contained; no external config. Default.
//   --url <base>       Target a running hyper-mcp (e.g. https://hyper-mcp.onrender.com).
//                      Requires env:
//                        HYPER_MCP_ADMIN_PRIVATE_JWK   admin private JWK (JSON) whose
//                                                      public counterpart is configured
//                                                      on the target as the admin trust root
//                        HYPER_MCP_ADMIN_ISSUER        admin issuer (default "admin-agent")
//                        HYPER_MCP_ADMIN_AUDIENCE      admin audience (default "hyper-mcp")
//                        HYPER_MCP_ADMIN_KID           admin kid (default "admin-1")
//                      The target must have the matching admin public JWK configured.
//
//   --timeout-ms <ms>  per-MCP-request timeout (default 30000)

import { generateKeyPair, SignJWT, exportJWK, importJWK } from "jose";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { PgliteBackend } from "../src/pglite-backend.js";
import { createApp } from "../src/app.js";
import { loadConfig } from "../src/config.js";
import type { Server } from "node:http";

type Mode = { kind: "local" } | { kind: "remote"; baseUrl: string };

function parseArgs(argv: string[]): { mode: Mode; timeoutMs: number } {
  let mode: Mode = { kind: "local" };
  let timeoutMs = 30_000;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--local") mode = { kind: "local" };
    else if (a === "--url") {
      const next = argv[++i];
      if (!next) throw new Error("--url requires a base URL");
      mode = { kind: "remote", baseUrl: next.replace(/\/+$/, "") };
    } else if (a === "--timeout-ms") {
      timeoutMs = Number(argv[++i]);
      if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) throw new Error("--timeout-ms must be positive");
    } else if (a === "--help" || a === "-h") {
      console.log(`hyper-mcp agent integration verifier\n\nUsage:\n  tsx scripts/agent-integration.ts --local\n  tsx scripts/agent-integration.ts --url https://hyper-mcp.onrender.com\n\nOptions:\n  --local              boot in-process hyper-mcp (default)\n  --url <base>         target a running instance\n  --timeout-ms <ms>    per-request timeout (default 30000)\n\nRemote env:\n  HYPER_MCP_ADMIN_PRIVATE_JWK  admin private JWK JSON\n  HYPER_MCP_ADMIN_ISSUER       default admin-agent\n  HYPER_MCP_ADMIN_AUDIENCE    default hyper-mcp\n  HYPER_MCP_ADMIN_KID          default admin-1\n`);
      process.exit(0);
    } else {
      throw new Error(`unknown arg: ${a}`);
    }
  }
  return { mode, timeoutMs };
}

interface KeyMat { kid: string; privateKey: any; publicJwk: any; issuer: string }

async function adminKeys(): Promise<KeyMat> {
  const issuer = process.env.HYPER_MCP_ADMIN_ISSUER || "admin-agent";
  const kid = process.env.HYPER_MCP_ADMIN_KID || "admin-1";
  const jwkJson = process.env.HYPER_MCP_ADMIN_PRIVATE_JWK;
  if (!jwkJson) throw new Error("HYPER_MCP_ADMIN_PRIVATE_JWK is required for --url mode (admin private JWK JSON)");
  const privateKey = await importJWK(JSON.parse(jwkJson));
  // Public JWK = private JWK minus private fields. For Ed25519, export public only.
  const pub = await exportJWK(privateKey);
  return { kid, privateKey, publicJwk: { kty: pub.kty, crv: pub.crv, x: pub.x, kid }, issuer };
}

async function genKeyMat(kid: string, issuer: string): Promise<KeyMat> {
  const pair = await generateKeyPair("Ed25519", { extractable: true });
  return { kid, privateKey: pair.privateKey, publicJwk: { ...(await exportJWK(pair.publicKey)), kid }, issuer };
}

async function signAdmin(km: KeyMat) {
  return new SignJWT({ scope: "accounts:admin" })
    .setProtectedHeader({ alg: "EdDSA", kid: km.kid })
    .setIssuer(km.issuer)
    .setAudience("hyper-mcp")
    .setExpirationTime("1h")
    .sign(km.privateKey);
}

async function signAccount(km: KeyMat) {
  return new SignJWT({})
    .setProtectedHeader({ alg: "EdDSA", kid: km.kid })
    .setIssuer(km.issuer)
    .setAudience("hyper-mcp")
    .setExpirationTime("1h")
    .sign(km.privateKey);
}

async function register(baseUrl: string, admin: KeyMat, account: KeyMat, scopes: string[]) {
  const ports: Record<string, boolean> = {};
  for (const s of scopes) ports[s] = true;
  const res = await fetch(`${baseUrl}/register`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${await signAdmin(admin)}` },
    body: JSON.stringify({ accountId: account.issuer, name: account.issuer, issuer: account.issuer, audience: "hyper-mcp", publicJwk: account.publicJwk, ports }),
  });
  if (res.status === 503) throw new Error(`target reports admin_not_configured (503). Configure the admin public JWK on the target to match HYPER_MCP_ADMIN_PRIVATE_JWK, then retry.`);
  if (res.status !== 201) throw new Error(`/register failed: ${res.status} ${await res.text()}`);
}

function makeClient(baseUrl: string, account: KeyMat, timeoutMs: number) {
  return (async () => {
    const token = await signAccount(account);
    const transport = new StreamableHTTPClientTransport(new URL(`${baseUrl}/mcp`), {
      requestInit: { headers: { authorization: `Bearer ${token}` } },
    });
    const client = new Client({ name: "scoutos-agent", version: "0.1.0" }, { capabilities: {} });
    await client.connect(transport, { timeout: timeoutMs });
    return client;
  })();
}

async function call(c: Client, name: string, args: Record<string, unknown>) {
  const res = await c.callTool({ name, arguments: args });
  if (res.isError) throw new Error(`${name} returned tool error: ${(res.content as any)[0]?.text}`);
  return JSON.parse((res.content as any)[0]?.text);
}

type Step = { id: string; name: string; run: () => Promise<string> };
let passed = 0, failed = 0;
async function runStep(s: Step) {
  try {
    const detail = await s.run();
    console.log(`  PASS ${s.id} — ${s.name}${detail ? ` — ${detail}` : ""}`);
    passed++;
  } catch (e) {
    console.error(`  FAIL ${s.id} — ${s.name} — ${(e as Error).message}`);
    failed++;
  }
}

async function runAgentFlow(baseUrl: string, admin: KeyMat, scout: KeyMat, other: KeyMat, timeoutMs: number) {
  console.log(`\nTarget: ${baseUrl}`);
  await register(baseUrl, admin, scout, [
    "data:read", "data:write", "cache:read", "cache:write", "blob:read", "blob:write",
    "queue:read", "queue:write", "search:read", "search:write",
  ]);
  await register(baseUrl, admin, other, ["data:read"]);

  const client = await makeClient(baseUrl, scout, timeoutMs);
  try {
    await runStep({ id: "init", name: "initialize + tools/list", run: async () => {
      const { tools } = await client.listTools();
      const names = tools.map((t) => t.name);
      for (const r of ["data_create", "cache_set", "blob_put_text", "queue_publish", "search_query"]) {
        if (!names.includes(r)) throw new Error(`missing tool ${r}`);
      }
      return `${tools.length} tools`;
    } });
    await runStep({ id: "data", name: "data create→find", run: async () => {
      const c = await call(client, "data_create", { collection: "things", document: { kind: "widget", n: 7 } });
      const f = await call(client, "data_find", { collection: "things" });
      if (!f.documents.some((d: any) => d.n === 7)) throw new Error("doc not found");
      return `id=${c.id}`;
    } });
    await runStep({ id: "cache", name: "cache set→get", run: async () => {
      await call(client, "cache_set", { key: "greeting", value: { msg: "hello scout" } });
      const g = await call(client, "cache_get", { key: "greeting" });
      if (g.value?.msg !== "hello scout") throw new Error("value mismatch");
      return "ok";
    } });
    await runStep({ id: "blob", name: "blob put_text→get_text", run: async () => {
      await call(client, "blob_put_text", { key: "notes/hello.txt", text: "hello scout", contentType: "text/plain" });
      const g = await call(client, "blob_get_text", { key: "notes/hello.txt" });
      if (g.text !== "hello scout") throw new Error("text mismatch");
      return "ok";
    } });
    await runStep({ id: "queue", name: "queue create→publish→subscribe→poll", run: async () => {
      await call(client, "queue_create_topic", { topic: "events" });
      await call(client, "queue_publish", { topic: "events", value: { hello: 1 } });
      const sub = await call(client, "queue_subscribe", { topic: "events", autoOffsetReset: "earliest" });
      const p = await call(client, "queue_poll", { topic: "events", subscriptionId: sub.subscriptionId, limit: 10 });
      if (!p.messages.some((m: any) => m.value?.hello === 1)) throw new Error("message not polled");
      return `${p.messages.length} msgs`;
    } });
    await runStep({ id: "search", name: "search create→index→query", run: async () => {
      await call(client, "search_create_index", { index: "docs" });
      await call(client, "search_index_doc", { index: "docs", id: "a", document: { title: "hello scout agent" } });
      const q = await call(client, "search_query", { index: "docs", q: "scout" });
      if (!q.hits.some((h: any) => h.id === "a")) throw new Error("hit not found");
      return `${q.hits.length} hits`;
    } });
  } finally {
    await client.close().catch(() => undefined);
  }

  // Tenant isolation: a second agent must not see the first agent's data.
  const otherClient = await makeClient(baseUrl, other, timeoutMs);
  try {
    await runStep({ id: "isolation", name: "second agent cannot see first's data", run: async () => {
      const f = await call(otherClient, "data_find", { collection: "things" });
      if (f.total !== 0) throw new Error(`expected 0, got ${f.total}`);
      return "isolated";
    } });
  } finally {
    await otherClient.close().catch(() => undefined);
  }
}

async function main() {
  const { mode, timeoutMs } = parseArgs(process.argv.slice(2));

  if (mode.kind === "remote") {
    const admin = await adminKeys();
    const scout = await genKeyMat("scout-1", "scout-agent");
    const other = await genKeyMat("other-1", "other-agent");
    await runAgentFlow(mode.baseUrl, admin, scout, other, timeoutMs);
  } else {
    // Local: boot in-process hyper-mcp with generated admin keys.
    const dir = await mkdtemp(join(tmpdir(), "hyper-mcp-int-local-"));
    const db = new PgliteBackend(dir);
    const admin = await genKeyMat("admin-1", "admin-agent");
    const scout = await genKeyMat("acc-1", "scout-agent");
    const other = await genKeyMat("acc-other", "other-agent");
    const config = loadConfig({
      HYPER_MCP_ADMIN_PUBLIC_JWK: JSON.stringify(admin.publicJwk),
      HYPER_MCP_ADMIN_ISSUER: admin.issuer,
      HYPER_MCP_ADMIN_AUDIENCE: "hyper-mcp",
      HYPER_MCP_ADMIN_KID: admin.kid,
      HYPER_MCP_AUTH_REQUIRED: "true",
    } as any);
    const getPorts = async () => db;
    const app = createApp(config, getPorts);
    const server: Server = await new Promise((resolve) => {
      const s = app.listen(0, "127.0.0.1", () => resolve(s));
    });
    const addr = server.address() as any;
    const baseUrl = `http://127.0.0.1:${addr.port}`;
    try {
      await runAgentFlow(baseUrl, admin, scout, other, timeoutMs);
    } finally {
      await new Promise<void>((r) => server.close(() => r()));
      await db.close().catch(() => undefined);
      await rm(dir, { recursive: true, force: true }).catch(() => undefined);
    }
  }

  console.log(`\nAgent integration: ${passed} passed, ${failed} failed`);
  process.exitCode = failed > 0 ? 1 : 0;
}

main().catch((e) => {
  console.error("agent-integration error:", (e as Error).message);
  process.exitCode = 1;
});
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { generateKeyPair, SignJWT, exportJWK } from "jose";
import type { Server } from "node:http";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { PgliteBackend } from "../src/pglite-backend.js";
import { createApp } from "../src/app.js";
import { loadConfig } from "../src/config.js";
import type { Config } from "../src/config.js";
import type { Ports } from "../src/ports/types.js";

// This test verifies the thing the architecture review calls "the first serious
// proof of the abstraction": that a real agent using the official MCP client SDK
// (the same path a ScoutOS-hosted agent would take) can authenticate against
// hyper-mcp, run the initialize handshake, list tools, and successfully call a
// representative write+read tool on each of the five ports — over real HTTP,
// with a signed account JWT. It is the end-to-end integration check that the
// unit-level http-routes.test.ts deliberately stops short of.

let dir: string;
let db: PgliteBackend;
let server: Server | undefined;
let baseUrl: string;
let adminPrivate: any;
let accountPrivate: any;
let accountJwk: any;
let otherPrivate: any;
let otherJwk: any;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "hyper-mcp-agent-int-"));
  db = new PgliteBackend(dir);

  const adminPair = await generateKeyPair("Ed25519", { extractable: true });
  adminPrivate = adminPair.privateKey;
  const adminJwk = { ...(await exportJWK(adminPair.publicKey)), kid: "admin-1" };

  const accountPair = await generateKeyPair("Ed25519", { extractable: true });
  accountPrivate = accountPair.privateKey;
  accountJwk = { ...(await exportJWK(accountPair.publicKey)), kid: "acc-1" };

  const otherPair = await generateKeyPair("Ed25519", { extractable: true });
  otherPrivate = otherPair.privateKey;
  otherJwk = { ...(await exportJWK(otherPair.publicKey)), kid: "acc-other" };

  const config = loadConfig({
    HYPER_MCP_ADMIN_PUBLIC_JWK: JSON.stringify(adminJwk),
    HYPER_MCP_ADMIN_ISSUER: "admin-agent",
    HYPER_MCP_ADMIN_AUDIENCE: "hyper-mcp",
    HYPER_MCP_ADMIN_KID: "admin-1",
    HYPER_MCP_AUTH_REQUIRED: "true",
  } as any);

  const getPorts = (): Promise<Ports> => Promise.resolve(db);
  const app = createApp(config, getPorts);
  await new Promise<void>((resolve) => {
    server = app.listen(0, "127.0.0.1", () => {
      const addr = server!.address() as any;
      baseUrl = `http://127.0.0.1:${addr.port}`;
      resolve();
    });
  });

  // Register the agent account with every port scope (admin signs the register call).
  await registerAccount("scout-agent", accountJwk, [
    "data:read", "data:write",
    "cache:read", "cache:write",
    "blob:read", "blob:write",
    "queue:read", "queue:write",
    "search:read", "search:write",
  ]);
  // Register a second, read-only agent for tenant-isolation checks.
  await registerAccount("other-agent", otherJwk, ["data:read"]);
});

afterEach(async () => {
  if (server) await new Promise<void>((r) => server!.close(() => r()));
  if (db) await db.close().catch(() => undefined);
  if (dir) await rm(dir, { recursive: true, force: true }).catch(() => undefined);
});

async function adminJwt() {
  return new SignJWT({ scope: "accounts:admin" })
    .setProtectedHeader({ alg: "EdDSA", kid: "admin-1" })
    .setIssuer("admin-agent")
    .setAudience("hyper-mcp")
    .setExpirationTime("1h")
    .sign(adminPrivate);
}

async function accountJwt(issuer: string, kid: string, key: any) {
  return new SignJWT({})
    .setProtectedHeader({ alg: "EdDSA", kid })
    .setIssuer(issuer)
    .setAudience("hyper-mcp")
    .setExpirationTime("1h")
    .sign(key);
}

async function registerAccount(accountId: string, publicJwk: any, scopes: string[]) {
  const ports: Record<string, boolean> = {};
  for (const s of scopes) ports[s] = true;
  const res = await fetch(`${baseUrl}/register`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${await adminJwt()}` },
    body: JSON.stringify({ accountId, name: accountId, issuer: accountId, audience: "hyper-mcp", publicJwk, ports }),
  });
  expect(res.status).toBe(201);
}

async function makeClient(issuer: string, kid: string, key: any) {
  // The agent signs its own JWT and presents it as a bearer on every request,
  // exactly as a ScoutOS agent configured with hyper-mcp would.
  const token = await accountJwt(issuer, kid, key);
  const transport = new StreamableHTTPClientTransport(new URL(`${baseUrl}/mcp`), {
    requestInit: { headers: { authorization: `Bearer ${token}` } },
  });
  const client = new Client({ name: "scoutos-agent", version: "0.1.0" }, { capabilities: {} });
  await client.connect(transport);
  return client;
}

async function call(c: Client, name: string, arguments_: Record<string, unknown>) {
  const res = await c.callTool({ name, arguments: arguments_ });
  expect(res.isError, `${name} returned an error`).toBeFalsy();
  const text = (res.content as any)[0]?.text;
  expect(typeof text).toBe("string");
  return JSON.parse(text);
}

describe("agent integration: real MCP client over streamable HTTP", () => {
  let client: Client;

  beforeEach(async () => {
    client = await makeClient("scout-agent", "acc-1", accountPrivate);
  });
  afterEach(async () => {
    if (client) await client.close().catch(() => undefined);
  });

  it("runs the initialize handshake and lists the five-port tools", async () => {
    const { tools } = await client.listTools();
    const names = tools.map((t) => t.name);
    for (const required of ["data_create", "data_find", "cache_set", "cache_get", "blob_put_text", "blob_get_text", "queue_publish", "queue_poll", "search_index_doc", "search_query"]) {
      expect(names).toContain(required);
    }
  });

  it("data: create then find round-trips", async () => {
    const created = await call(client, "data_create", { collection: "things", document: { kind: "widget", n: 7 } });
    expect(created.ok).toBe(true);
    expect(typeof created.id).toBe("string");
    const found = await call(client, "data_find", { collection: "things" });
    expect(found.total).toBeGreaterThanOrEqual(1);
    expect(found.documents.some((d: any) => d.kind === "widget" && d.n === 7)).toBe(true);
  });

  it("cache: set then get round-trips", async () => {
    await call(client, "cache_set", { key: "greeting", value: { msg: "hello scout" } });
    const got = await call(client, "cache_get", { key: "greeting" });
    expect(got.found).toBe(true);
    expect(got.value).toEqual({ msg: "hello scout" });
  });

  it("blob: put_text then get_text round-trips", async () => {
    await call(client, "blob_put_text", { key: "notes/hello.txt", text: "hello scout", contentType: "text/plain" });
    const got = await call(client, "blob_get_text", { key: "notes/hello.txt" });
    expect(got.text).toBe("hello scout");
    expect(got.contentType).toBe("text/plain");
  });

  it("queue: create → publish → subscribe → poll round-trips", async () => {
    await call(client, "queue_create_topic", { topic: "events" });
    await call(client, "queue_publish", { topic: "events", value: { hello: 1 } });
    const sub = await call(client, "queue_subscribe", { topic: "events", autoOffsetReset: "earliest" });
    const polled = await call(client, "queue_poll", { topic: "events", subscriptionId: sub.subscriptionId, limit: 10 });
    expect(polled.messages.length).toBeGreaterThanOrEqual(1);
    expect(polled.messages[0].value).toEqual({ hello: 1 });
  });

  it("search: create → index → query round-trips", async () => {
    await call(client, "search_create_index", { index: "docs" });
    await call(client, "search_index_doc", { index: "docs", id: "a", document: { title: "hello scout agent" } });
    const res = await call(client, "search_query", { index: "docs", q: "scout" });
    expect(res.hits.some((h: any) => h.id === "a")).toBe(true);
  });
});

describe("agent integration: tenant isolation over MCP", () => {
  let scout: Client;
  let other: Client;

  beforeEach(async () => {
    scout = await makeClient("scout-agent", "acc-1", accountPrivate);
    other = await makeClient("other-agent", "acc-other", otherPrivate);
  });
  afterEach(async () => {
    if (scout) await scout.close().catch(() => undefined);
    if (other) await other.close().catch(() => undefined);
  });

  it("a second agent cannot see the first agent's data", async () => {
    await call(scout, "data_create", { collection: "secrets", document: { token: "only-for-scout" } });
    // The other agent's account_id is different, so its "secrets" collection is empty.
    const theirs = await call(other, "data_find", { collection: "secrets" });
    expect(theirs.total).toBe(0);
  });
});
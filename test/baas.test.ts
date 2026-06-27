import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Server } from "node:http";
import { PgliteBackend } from "../src/pglite-backend.js";
import { createApp } from "../src/app.js";
import { loadConfig } from "../src/config.js";
import type { Config } from "../src/config.js";
import type { Ports } from "../src/ports/types.js";

let dir: string;
let db: PgliteBackend;
let server: Server | undefined;
let baseUrl: string;

const ACCT = "myapp";

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "hyper-mcp-baas-"));
  db = new PgliteBackend(dir);
});

afterEach(async () => {
  if (server) await new Promise<void>(r => server!.close(() => r()));
  if (db) await db.close().catch(() => undefined);
  if (dir) await rm(dir, { recursive: true, force: true }).catch(() => undefined);
});

function startApp() {
  const config: Config = loadConfig({ HYPER_MCP_TRUST_MODE: "local", HYPER_MCP_AUTH_REQUIRED: "false" } as any);
  const getPorts = (): Promise<Ports> => Promise.resolve(db);
  const app = createApp(config, getPorts);
  return new Promise<void>((resolve) => {
    server = app.listen(0, "127.0.0.1", () => {
      baseUrl = `http://127.0.0.1:${(server!.address() as any).port}`;
      resolve();
    });
  });
}

async function reg(name: string, body: string, isPublic: boolean) {
  await db.appCreateFunction(ACCT, name, body, isPublic);
}

async function callFn(name: string, body: unknown, token?: string) {
  const headers: Record<string, string> = { "content-type": "application/json" };
  if (token) headers.authorization = `Bearer ${token}`;
  const res = await fetch(`${baseUrl}/u/${ACCT}/${name}`, { method: "POST", headers, body: JSON.stringify(body ?? {}) });
  let json: any = null;
  try { json = await res.json(); } catch {}
  return { status: res.status, json };
}

const SIGNUP = `async (ctx) => {
  const u = await ctx.auth.createUser({ email: ctx.body.email });
  await ctx.auth.setPassword(u.userId, ctx.body.password);
  const s = await ctx.auth.createSession(u.userId);
  return { userId: u.userId, token: s.token };
}`;
const LOGIN = `async (ctx) => {
  const f = await ctx.auth.findUsers({ email: ctx.body.email });
  if (!f.users.length) return { error: "no_user" };
  const u = f.users[0];
  const v = await ctx.auth.verifyPassword(u.userId, ctx.body.password);
  if (!v.valid) return { error: "bad_password" };
  const s = await ctx.auth.createSession(u.userId);
  return { userId: u.userId, token: s.token };
}`;
const ME = `async (ctx) => ({ user: ctx.user, profile: await ctx.db.get("profile", "me") })`;
const CREATE_POST = `async (ctx) => { const p = await ctx.db.create("posts", { text: ctx.body.text }); return p; }`;
const LIST_POSTS = `async (ctx) => await ctx.db.find("posts")`;
const EVIL_PROCESS = `async (ctx) => { return typeof process !== "undefined" ? process.env : "no process" }`;

describe("BaaS /u/:accountId/:fn", () => {
  beforeEach(async () => {
    await startApp();
    await reg("signup", SIGNUP, true);
    await reg("login", LOGIN, true);
    await reg("me", ME, false);
    await reg("createPost", CREATE_POST, false);
    await reg("listPosts", LIST_POSTS, false);
    await reg("evil", EVIL_PROCESS, false);
  });

  it("signup (public) creates a user + password + session and returns a token", async () => {
    const r = await callFn("signup", { email: "ada@x.com", password: "pw-ada" });
    expect(r.status).toBe(200);
    expect(r.json.ok).toBe(true);
    expect(r.json.result.userId).toBeTruthy();
    expect(r.json.result.token).toBeTruthy();
  });

  it("login (public) verifies the password and returns a fresh token", async () => {
    await callFn("signup", { email: "ada@x.com", password: "pw-ada" });
    const r = await callFn("login", { email: "ada@x.com", password: "pw-ada" });
    expect(r.status).toBe(200);
    expect(r.json.result.token).toBeTruthy();
    const bad = await callFn("login", { email: "ada@x.com", password: "wrong" });
    expect(bad.json.result.error).toBe("bad_password");
  });

  it("authed function without a token returns 401", async () => {
    const r = await callFn("me", {});
    expect(r.status).toBe(401);
    expect(r.json.error).toBe("AUTH_REQUIRED");
  });

  it("authed function with a valid token returns ctx.user and scoped data", async () => {
    const su = await callFn("signup", { email: "ada@x.com", password: "pw-ada" });
    const token = su.json.result.token;
    const me = await callFn("me", {}, token);
    expect(me.status).toBe(200);
    expect(me.json.result.user.id).toBeTruthy();
    expect(me.json.result.user.accountId).toBe(ACCT);
    expect(me.json.result.profile).toEqual({ document: null, found: false });
  });

  it("ctx.db is user-scoped: user B cannot see user A's posts (RLS)", async () => {
    const a = await callFn("signup", { email: "ada@x.com", password: "pw-ada" });
    const b = await callFn("signup", { email: "bea@x.com", password: "pw-bea" });
    const ta = a.json.result.token;
    const tb = b.json.result.token;

    const post = await callFn("createPost", { text: "ada's secret" }, ta);
    expect(post.status).toBe(200);
    expect(post.json.result.ok).toBe(true);

    const aList = await callFn("listPosts", {}, ta);
    expect(aList.json.result.total).toBe(1);
    expect(aList.json.result.documents[0].text).toBe("ada's secret");

    const bList = await callFn("listPosts", {}, tb);
    expect(bList.json.result.total).toBe(0);
    expect(bList.json.result.documents).toEqual([]);
  });

  it("a tampered/invalid token is rejected with 401", async () => {
    const r = await callFn("me", {}, "not-a-real-session-token");
    expect(r.status).toBe(401);
  });

  it("unknown function returns 404", async () => {
    const r = await callFn("nope", {});
    expect(r.status).toBe(404);
    expect(r.json.error).toBe("FUNCTION_NOT_FOUND");
  });

  it("sandbox does not expose process (prototype runtime)", async () => {
    const su = await callFn("signup", { email: "ada@x.com", password: "pw-ada" });
    const r = await callFn("evil", {}, su.json.result.token);
    // process is undefined in the sandbox -> the function returns "no process"
    // (a genuine escape would return process.env). Prototype runtime must not
    // expose host globals.
    expect(r.status).toBe(200);
    expect(r.json.result).toBe("no process");
  });

  it("function store is tenant-isolated by account", async () => {
    await db.appCreateFunction("other-acct", "signup", SIGNUP, true);
    // myapp cannot see other-acct's functions
    const r = await callFn("signup", { email: "x@x.com", password: "pw" });
    expect(r.status).toBe(200); // myapp has its own signup
    const other = await fetch(`${baseUrl}/u/other-acct/signup`, {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ email: "y@x.com", password: "pw" }),
    });
    expect(other.status).toBe(200);
    // a third account has no signup
    const none = await fetch(`${baseUrl}/u/ghost/signup`, {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({}),
    });
    expect(none.status).toBe(404);
  });
});

describe("BaaS function management (MCP store)", () => {
  it("creates, gets, lists, and deletes functions, tenant-isolated", async () => {
    await db.appCreateFunction(ACCT, "ping", `async (ctx) => "pong"`, false);
    const got = await db.appGetFunction(ACCT, "ping");
    expect(got.found).toBe(true);
    expect(got.fn!.public).toBe(false);

    const listed = await db.appListFunctions(ACCT);
    expect(listed.functions.map((f: any) => f.name)).toContain("ping");

    // tenant isolation: other account cannot see myapp's function
    expect((await db.appGetFunction("other", "ping")).found).toBe(false);

    expect((await db.appDeleteFunction(ACCT, "ping")).deleted).toBe(true);
    expect((await db.appGetFunction(ACCT, "ping")).found).toBe(false);
  });

  it("re-registering a function bumps the version", async () => {
    const v1 = await db.appCreateFunction(ACCT, "ping", `async (ctx) => 1`, false);
    const v2 = await db.appCreateFunction(ACCT, "ping", `async (ctx) => 2`, true);
    expect(v1.version).toBe(1);
    expect(v2.version).toBe(2);
    expect((await db.appGetFunction(ACCT, "ping")).fn!.public).toBe(true);
  });
});
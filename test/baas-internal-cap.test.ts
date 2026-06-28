import { describe, expect, it, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PgliteBackend } from "../src/pglite-backend.js";
import { createCapSecret, signCapToken, verifyCapToken, createCapabilityHandler } from "../src/baas/cap.js";

let dir: string;
let db: PgliteBackend;
let secret: string;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "hyper-mcp-cap-"));
  db = new PgliteBackend(dir);
  secret = createCapSecret();
});
afterEach(async () => {
  if (db) await db.close().catch(() => undefined);
  if (dir) await rm(dir, { recursive: true, force: true }).catch(() => undefined);
});

function call(op: string, body: any, token?: string) {
  const handler = createCapabilityHandler(db, secret);
  const req: any = { params: { op }, headers: token ? { authorization: `Bearer ${token}` } : {}, body };
  const res: any = {
    status(code: number) { this._s = code; return this; },
    json(x: any) { this._j = x; return this; },
  };
  return handler(req, res).then(() => ({ status: res._s ?? 200, json: res._j }));
}

describe("internal capability token", () => {
  it("signs and verifies a cap token", async () => {
    const tok = await signCapToken(secret, { accountId: "acct", userId: "u1" }, 60_000);
    const ctx = await verifyCapToken(secret, tok);
    expect(ctx).toEqual({ accountId: "acct", userId: "u1" });
  });

  it("rejects a token signed with a different secret", async () => {
    const tok = await signCapToken("deadbeef".repeat(8), { accountId: "acct", userId: "u1" }, 60_000);
    await expect(verifyCapToken(secret, tok)).rejects.toThrow();
  });

  it("rejects an expired token", async () => {
    const tok = await signCapToken(secret, { accountId: "acct", userId: "u1" }, -1_000);
    // jose sets exp in the past; allow a tick
    await new Promise(r => setTimeout(r, 50));
    await expect(verifyCapToken(secret, tok)).rejects.toThrow();
  });
});

describe("capability handler — auth + scoping", () => {
  it("rejects without a token (401)", async () => {
    const r = await call("db_create", { collection: "c", document: { _id: "1" } });
    expect(r.status).toBe(401);
  });

  it("rejects a tampered token (401)", async () => {
    const tok = await signCapToken(secret, { accountId: "acct", userId: "u1" }, 60_000);
    const r = await call("db_create", { collection: "c", document: { _id: "1" } }, tok + "X");
    expect(r.status).toBe(401);
  });

  it("db ops are user-scoped: user B cannot read user A's rows", async () => {
    const tokA = await signCapToken(secret, { accountId: "acct", userId: "a" }, 60_000);
    const tokB = await signCapToken(secret, { accountId: "acct", userId: "b" }, 60_000);
    await call("db_create", { collection: "posts", document: { _id: "p1", text: "a's post" } }, tokA);
    const aList = await call("db_find", { collection: "posts" }, tokA);
    expect(aList.json.total).toBe(1);
    const bList = await call("db_find", { collection: "posts" }, tokB);
    expect(bList.json.total).toBe(0);
    expect(bList.json.documents).toEqual([]);
  });

  it("db ops require a userId (public-function token -> 400)", async () => {
    const tok = await signCapToken(secret, { accountId: "acct", userId: null }, 60_000);
    const r = await call("db_create", { collection: "c", document: {} }, tok);
    expect(r.status).toBe(400);
  });

  it("auth_createUser works with an account-only (public) token", async () => {
    const tok = await signCapToken(secret, { accountId: "acct", userId: null }, 60_000);
    const r = await call("auth_createUser", { input: { email: "x@x.com" } }, tok);
    expect(r.json.ok).toBe(true);
    expect(r.json.userId).toBeTruthy();
  });

  it("unknown op returns 404", async () => {
    const tok = await signCapToken(secret, { accountId: "acct", userId: "u1" }, 60_000);
    const r = await call("nope", {}, tok);
    expect(r.status).toBe(404);
  });
});
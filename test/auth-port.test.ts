import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PgliteBackend } from "../src/pglite-backend.js";
import { PortError } from "../src/errors.js";

let dir: string;
let db: PgliteBackend;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "hyper-mcp-auth-"));
  db = new PgliteBackend(dir);
});

afterEach(async () => {
  if (db) await db.close().catch(() => undefined);
  if (dir) await rm(dir, { recursive: true, force: true }).catch(() => undefined);
});

async function expectPortError(p: Promise<unknown>, code: string, status: number) {
  await p.then(
    () => { throw new Error(`expected PortError ${code}, got success`); },
    (e) => {
      expect(e).toBeInstanceOf(PortError);
      expect((e as PortError).code).toBe(code);
      expect((e as PortError).status).toBe(status);
    },
  );
}

describe("auth port — users", () => {
  it("creates, gets, finds, updates, and deletes a user", async () => {
    const created = await db.authCreateUser("acct-a", { email: "ada@x.com", username: "ada", attributes: { role: "admin" } });
    expect(created.ok).toBe(true);
    expect(created.userId).toBeTruthy();

    const got = await db.authGetUser("acct-a", created.userId);
    expect(got.found).toBe(true);
    expect(got.user).toMatchObject({ email: "ada@x.com", username: "ada", status: "active" });
    expect(got.user!.attributes).toEqual({ role: "admin" });
    // Never returns credentials
    expect(JSON.stringify(got.user)).not.toContain("hash");
    expect(JSON.stringify(got.user)).not.toContain("password");

    const found = await db.authFindUsers("acct-a", { email: "ada@x.com" });
    expect(found.users).toHaveLength(1);
    expect(found.users[0].userId).toBe(created.userId);

    const updated = await db.authUpdateUser("acct-a", created.userId, { attributes: { city: "London" }, status: "suspended" });
    expect(updated.matchedCount).toBe(1);
    const after = await db.authGetUser("acct-a", created.userId);
    expect(after.user!.attributes).toEqual({ role: "admin", city: "London" });
    expect(after.user!.status).toBe("suspended");

    const del = await db.authDeleteUser("acct-a", created.userId);
    expect(del.deleted).toBe(true);
    expect((await db.authGetUser("acct-a", created.userId)).found).toBe(false);
  });

  it("rejects duplicate email within an account with 409", async () => {
    await db.authCreateUser("acct-a", { email: "dup@x.com" });
    await expectPortError(db.authCreateUser("acct-a", { email: "dup@x.com" }), "AUTH_DUPLICATE", 409);
  });

  it("allows the same email in different accounts (tenant isolation)", async () => {
    await db.authCreateUser("acct-a", { email: "shared@x.com" });
    const b = await db.authCreateUser("acct-b", { email: "shared@x.com" });
    expect(b.ok).toBe(true);
  });

  it("isolates users by account_id", async () => {
    const a = await db.authCreateUser("acct-a", { email: "a@x.com" });
    expect((await db.authGetUser("acct-b", a.userId)).found).toBe(false);
    expect((await db.authFindUsers("acct-b", { email: "a@x.com" })).users).toHaveLength(0);
  });

  it("update rejects duplicate username with 409", async () => {
    await db.authCreateUser("acct-a", { username: "taken" });
    const u2 = await db.authCreateUser("acct-a", { username: "other" });
    await expectPortError(db.authUpdateUser("acct-a", u2.userId, { username: "taken" }), "AUTH_DUPLICATE", 409);
  });

  it("update of unknown user returns matchedCount 0", async () => {
    const r = await db.authUpdateUser("acct-a", "nope", { attributes: { x: 1 } });
    expect(r.matchedCount).toBe(0);
  });
});

describe("auth port — passwords", () => {
  it("sets and verifies a password (scrypt)", async () => {
    const u = await db.authCreateUser("acct-a", { email: "p@x.com" });
    await db.authSetPassword("acct-a", u.userId, "correct horse battery staple");
    expect((await db.authVerifyPassword("acct-a", u.userId, "correct horse battery staple")).valid).toBe(true);
    expect((await db.authVerifyPassword("acct-a", u.userId, "wrong")).valid).toBe(false);
  });

  it("verify for a user with no password returns valid:false", async () => {
    const u = await db.authCreateUser("acct-a", { email: "np@x.com" });
    expect((await db.authVerifyPassword("acct-a", u.userId, "anything")).valid).toBe(false);
  });

  it("set_password requires an existing user (404)", async () => {
    await expectPortError(db.authSetPassword("acct-a", "ghost", "pw"), "AUTH_USER_NOT_FOUND", 404);
  });

  it("deleting a user removes their credential", async () => {
    const u = await db.authCreateUser("acct-a", { email: "d@x.com" });
    await db.authSetPassword("acct-a", u.userId, "pw");
    await db.authDeleteUser("acct-a", u.userId);
    expect((await db.authVerifyPassword("acct-a", u.userId, "pw")).valid).toBe(false);
  });

  it("passwords are tenant-isolated", async () => {
    const u = await db.authCreateUser("acct-a", { email: "t@x.com" });
    await db.authSetPassword("acct-a", u.userId, "pw-a");
    // acct-b cannot set/verify for acct-a's user id (different account)
    expect((await db.authVerifyPassword("acct-b", u.userId, "pw-a")).valid).toBe(false);
  });
});

describe("auth port — sessions", () => {
  it("creates, verifies, revokes, and lists sessions", async () => {
    const u = await db.authCreateUser("acct-a", { email: "s@x.com" });
    const s1 = await db.authCreateSession("acct-a", u.userId, { ttlSeconds: 3600 });
    expect(s1.token).toBeTruthy();
    expect(s1.userId).toBe(u.userId);

    const v = await db.authVerifySession("acct-a", s1.token);
    expect(v.valid).toBe(true);
    expect(v.userId).toBe(u.userId);
    expect(v.expiresAt).toBeTruthy();

    const listed = await db.authListSessions("acct-a", u.userId);
    expect(listed.sessions).toHaveLength(1);
    expect(listed.sessions[0].userId).toBe(u.userId);
    // list never returns a token/hash
    expect(JSON.stringify(listed)).not.toContain(s1.token);

    const rev = await db.authRevokeSession("acct-a", s1.token);
    expect(rev.revoked).toBe(true);
    expect((await db.authVerifySession("acct-a", s1.token)).valid).toBe(false);
    expect((await db.authListSessions("acct-a", u.userId)).sessions).toHaveLength(0);
  });

  it("rejects a tampered or unknown token", async () => {
    expect((await db.authVerifySession("acct-a", "totally-bogous-token")).valid).toBe(false);
    expect((await db.authRevokeSession("acct-a", "nope")).revoked).toBe(false);
  });

  it("expired sessions are invalid", async () => {
    const u = await db.authCreateUser("acct-a", { email: "e@x.com" });
    const s = await db.authCreateSession("acct-a", u.userId, { ttlSeconds: -1 });
    expect((await db.authVerifySession("acct-a", s.token)).valid).toBe(false);
  });

  it("sessions are tenant-isolated (acct-b token does not verify in acct-a)", async () => {
    const u = await db.authCreateUser("acct-a", { email: "ti@x.com" });
    const s = await db.authCreateSession("acct-a", u.userId);
    expect((await db.authVerifySession("acct-b", s.token)).valid).toBe(false);
  });

  it("create_session requires an existing user (404)", async () => {
    await expectPortError(db.authCreateSession("acct-a", "ghost"), "AUTH_USER_NOT_FOUND", 404);
  });
});

describe("auth port — one-time codes", () => {
  it("creates and verifies a code, then consumes it", async () => {
    const c = await db.authCreateCode("acct-a", { channel: "email", target: "u@x.com", userId: undefined });
    expect(c.code).toMatch(/^\d{6}$/);
    expect(c.codeId).toBeTruthy();

    const v = await db.authVerifyCode("acct-a", { channel: "email", target: "u@x.com", code: c.code });
    expect(v.valid).toBe(true);

    // consumed: second verify fails
    expect((await db.authVerifyCode("acct-a", { channel: "email", target: "u@x.com", code: c.code })).valid).toBe(false);
  });

  it("returns the bound userId on success", async () => {
    const u = await db.authCreateUser("acct-a", { email: "b@x.com" });
    const c = await db.authCreateCode("acct-a", { channel: "email", target: "b@x.com", userId: u.userId });
    const v = await db.authVerifyCode("acct-a", { channel: "email", target: "b@x.com", code: c.code });
    expect(v.valid).toBe(true);
    expect(v.userId).toBe(u.userId);
  });

  it("wrong code does not consume; after max_attempts the code is unusable", async () => {
    const c = await db.authCreateCode("acct-a", { channel: "sms", target: "+1", maxAttempts: 3 });
    for (let i = 0; i < 3; i++) {
      expect((await db.authVerifyCode("acct-a", { channel: "sms", target: "+1", code: "000000" })).valid).toBe(false);
    }
    // now attempts >= max_attempts -> even the correct code is unusable
    expect((await db.authVerifyCode("acct-a", { channel: "sms", target: "+1", code: c.code })).valid).toBe(false);
  });

  it("expired codes are invalid", async () => {
    const c = await db.authCreateCode("acct-a", { channel: "email", target: "ex@x.com", ttlSeconds: -1 });
    expect((await db.authVerifyCode("acct-a", { channel: "email", target: "ex@x.com", code: c.code })).valid).toBe(false);
  });

  it("create replaces any prior active code for the same target", async () => {
    const c1 = await db.authCreateCode("acct-a", { channel: "email", target: "r@x.com" });
    const c2 = await db.authCreateCode("acct-a", { channel: "email", target: "r@x.com" });
    expect(c1.code).not.toBe(c2.code);
    // old code no longer verifies
    expect((await db.authVerifyCode("acct-a", { channel: "email", target: "r@x.com", code: c1.code })).valid).toBe(false);
    expect((await db.authVerifyCode("acct-a", { channel: "email", target: "r@x.com", code: c2.code })).valid).toBe(true);
  });

  it("codes are tenant-isolated", async () => {
    const c = await db.authCreateCode("acct-a", { channel: "email", target: "ti@x.com" });
    expect((await db.authVerifyCode("acct-b", { channel: "email", target: "ti@x.com", code: c.code })).valid).toBe(false);
  });

  it("rejects invalid channel/target", async () => {
    await expectPortError(db.authCreateCode("acct-a", { channel: "owl" as any, target: "x" }), "VALIDATION_ERROR", 400);
    await expectPortError(db.authCreateCode("acct-a", { channel: "email", target: "" }), "VALIDATION_ERROR", 400);
  });
});

describe("auth port — health", () => {
  it("returns ok and a latency number", async () => {
    const h = await db.authHealth("acct-a");
    expect(h.ok).toBe(true);
    expect(typeof h.latencyMs).toBe("number");
  });
});
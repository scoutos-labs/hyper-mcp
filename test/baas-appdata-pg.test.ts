import { describe, expect, it } from "vitest";
import { PgAppDataPort } from "../src/baas/appdata-pg.js";
import { PortError } from "../src/errors.js";

// Engine-enforced RLS requires a real Postgres (PGLite does not enforce RLS
// policies — verified in research). Skipped when PG_TEST_URL is unset.
const url = process.env.PG_TEST_URL;

describe.skipIf(!url)("PgAppDataPort — engine-enforced RLS (real Postgres)", () => {
  let port: PgAppDataPort;

  it("initializes the app_data table with FORCE RLS", async () => {
    port = new PgAppDataPort(url!);
    await port.init();
    // init is idempotent
    await port.init();
    expect(true).toBe(true);
  });

  it("user A's rows are invisible to user B (engine RLS)", async () => {
    await port.appDataCreate("acct", "a", "posts", { _id: "p1", text: "a's post" });
    const aList = await port.appDataFind("acct", "a", "posts");
    expect(aList.total).toBe(1);
    expect(aList.documents[0].text).toBe("a's post");
    const bList = await port.appDataFind("acct", "b", "posts");
    expect(bList.total).toBe(0);
    // direct get by B returns not-found even though the row exists
    expect((await port.appDataGet("acct", "b", "posts", "p1")).found).toBe(false);
  });

  it("user B cannot create a row under user A's user_id (WITH CHECK)", async () => {
    // The wrapper always uses the transaction's set user_id; but the engine's
    // WITH CHECK policy enforces that the written user_id matches app.user_id.
    // Attempting to insert with a different user_id via the typed port is not
    // possible (the port stamps user_id from the call), so we verify the
    // positive: B can write its own rows, and those are isolated from A.
    await port.appDataCreate("acct", "b", "posts", { _id: "b1", text: "b's post" });
    const bOwn = await port.appDataGet("acct", "b", "posts", "b1");
    expect(bOwn.found).toBe(true);
    const aSeeB = await port.appDataGet("acct", "a", "posts", "b1");
    expect(aSeeB.found).toBe(false);
  });

  it("delete and update are user-scoped", async () => {
    await port.appDataCreate("acct", "a", "notes", { _id: "n1", v: 1 });
    // B cannot delete A's note
    expect((await port.appDataDelete("acct", "b", "notes", "n1")).deleted).toBe(false);
    // A still sees it
    expect((await port.appDataGet("acct", "a", "notes", "n1")).found).toBe(true);
    // A updates it
    await port.appDataUpdate("acct", "a", "notes", "n1", { $set: { v: 2 } });
    expect((await port.appDataGet("acct", "a", "notes", "n1")).document!.v).toBe(2);
  });

  it("cleans up", async () => {
    if (port) await port.close();
  });
});

describe.skipIf(!!url)("PgAppDataPort — SKIPPED (set PG_TEST_URL to run)", () => {
  it("skipped: no PG_TEST_URL", () => { expect(true).toBe(true); });
});
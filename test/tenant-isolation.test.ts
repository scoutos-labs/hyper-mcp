import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PgliteBackend } from "../src/pglite-backend.js";

let dir: string;
let db: PgliteBackend;

async function freshDb() {
  dir = await mkdtemp(join(tmpdir(), "hyper-mcp-tenant-"));
  db = new PgliteBackend(dir);
}

async function cleanupDb() {
  if (db) await db.close().catch(() => undefined);
  if (dir) await rm(dir, { recursive: true, force: true });
}

beforeEach(freshDb);
afterEach(cleanupDb);

describe("tenant isolation — data port", () => {
  it("isolates documents by account_id", async () => {
    await db.dataCreate("alpha", "docs", { _id: "d1", name: "Alpha's data" });
    await db.dataCreate("beta", "docs", { _id: "d1", name: "Beta's data" });

    expect((await db.dataGet("alpha", "docs", "d1")).document).toMatchObject({ name: "Alpha's data" });
    expect((await db.dataGet("beta", "docs", "d1")).document).toMatchObject({ name: "Beta's data" });

    expect((await db.dataFind("alpha", "docs", {})).total).toBe(1);
    expect((await db.dataFind("beta", "docs", {})).total).toBe(1);
  });

  it("same collection name exists independently per account", async () => {
    await db.dataCreate("alpha", "users", { _id: "u1", name: "Alice" });
    await db.dataCreate("beta", "users", { _id: "u1", name: "Bob" });

    expect((await db.dataGet("alpha", "users", "u1")).document).toMatchObject({ name: "Alice" });
    expect((await db.dataGet("beta", "users", "u1")).document).toMatchObject({ name: "Bob" });
  });

  it("drops are scoped to account", async () => {
    await db.dataCreate("alpha", "shared", { _id: "s1", v: 1 });
    await db.dataCreate("beta", "shared", { _id: "s1", v: 2 });

    await db.dataDropCollection("alpha", "shared");
    expect((await db.dataFind("alpha", "shared", {})).total).toBe(0);
    expect((await db.dataFind("beta", "shared", {})).total).toBe(1);
  });
});

describe("tenant isolation — cache port", () => {
  it("isolates cache keys by account_id", async () => {
    await db.cacheSet("alpha", "counter", 10);
    await db.cacheSet("beta", "counter", 20);

    expect((await db.cacheGet("alpha", "counter")).value).toBe(10);
    expect((await db.cacheGet("beta", "counter")).value).toBe(20);

    await db.cacheIncr("alpha", "counter", 5);
    expect((await db.cacheGet("alpha", "counter")).value).toBe(15);
    expect((await db.cacheGet("beta", "counter")).value).toBe(20);
  });

  it("delete only affects one account", async () => {
    await db.cacheSet("alpha", "shared-key", "alpha-val");
    await db.cacheSet("beta", "shared-key", "beta-val");

    await db.cacheDelete("alpha", "shared-key");
    expect((await db.cacheGet("alpha", "shared-key")).found).toBe(false);
    expect((await db.cacheGet("beta", "shared-key")).found).toBe(true);
  });
});

describe("tenant isolation — blob port", () => {
  it("isolates blobs by account_id", async () => {
    await db.blobPutText("alpha", "file.txt", "alpha content");
    await db.blobPutText("beta", "file.txt", "beta content");

    expect((await db.blobGetText("alpha", "file.txt")).text).toBe("alpha content");
    expect((await db.blobGetText("beta", "file.txt")).text).toBe("beta content");
  });

  it("lists only account's blobs", async () => {
    await db.blobPutText("alpha", "docs/a.txt", "a");
    await db.blobPutText("beta", "docs/b.txt", "b");

    expect((await db.blobList("alpha", { prefix: "docs/" })).total).toBe(1);
    expect((await db.blobList("beta", { prefix: "docs/" })).total).toBe(1);
    expect((await db.blobList("alpha", { prefix: "docs/" })).files[0].key).toBe("docs/a.txt");
    expect((await db.blobList("beta", { prefix: "docs/" })).files[0].key).toBe("docs/b.txt");
  });
});

describe("tenant isolation — queue port", () => {
  it("isolates topics by account_id", async () => {
    await db.queuePublish("alpha", "jobs", { value: "alpha-job" });
    await db.queuePublish("beta", "jobs", { value: "beta-job" });

    const alphaTopics = await db.queueListTopics("alpha");
    const betaTopics = await db.queueListTopics("beta");
    expect(alphaTopics.topics).toHaveLength(1);
    expect(betaTopics.topics).toHaveLength(1);
    expect(alphaTopics.topics[0].messageCount).toBe(1);
    expect(betaTopics.topics[0].messageCount).toBe(1);

    const alphaSub = await db.queueSubscribe("alpha", "jobs", "g1", false, "earliest");
    const alphaPoll = await db.queuePoll("alpha", "jobs", alphaSub.subscriptionId);
    expect(alphaPoll.messages[0].value).toBe("alpha-job");

    const betaSub = await db.queueSubscribe("beta", "jobs", "g2", false, "earliest");
    const betaPoll = await db.queuePoll("beta", "jobs", betaSub.subscriptionId);
    expect(betaPoll.messages[0].value).toBe("beta-job");
  });

  it("delete topic only affects one account", async () => {
    await db.queuePublish("alpha", "shared-topic", { value: 1 });
    await db.queuePublish("beta", "shared-topic", { value: 2 });

    await db.queueDeleteTopic("alpha", "shared-topic");
    expect((await db.queueListTopics("alpha")).topics).toHaveLength(0);
    expect((await db.queueListTopics("beta")).topics).toHaveLength(1);
  });
});

describe("tenant isolation — search port", () => {
  it("isolates search indexes by account_id", async () => {
    await db.searchIndexDoc("alpha", "docs", { title: "Alpha doc" }, "d1");
    await db.searchIndexDoc("beta", "docs", { title: "Beta doc" }, "d1");

    expect((await db.searchQuery("alpha", "docs", { query: { match_all: {} } })).total).toBe(1);
    expect((await db.searchQuery("beta", "docs", { query: { match_all: {} } })).total).toBe(1);
    expect((await db.searchQuery("alpha", "docs", { q: "alpha" })).total).toBe(1);
    expect((await db.searchQuery("beta", "docs", { q: "alpha" })).total).toBe(0);
  });

  it("delete index only affects one account", async () => {
    await db.searchIndexDoc("alpha", "idx", { title: "A" }, "d1");
    await db.searchIndexDoc("beta", "idx", { title: "B" }, "d1");

    await db.searchDeleteIndex("alpha", "idx");
    expect((await db.searchCount("alpha", "idx")).count).toBe(0);
    expect((await db.searchCount("beta", "idx")).count).toBe(1);
  });
});
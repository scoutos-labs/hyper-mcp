import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PgliteBackend } from "../src/pglite-backend.js";
import { PortError } from "../src/errors.js";

let dir: string;
let db: PgliteBackend;

async function freshDb() {
  dir = await mkdtemp(join(tmpdir(), "hyper-mcp-test-"));
  db = new PgliteBackend(dir);
}

async function cleanupDb() {
  if (db) await db.close().catch(() => undefined);
  if (dir) await rm(dir, { recursive: true, force: true });
}

beforeEach(freshDb);
afterEach(cleanupDb);

describe("data port", () => {
  it("creates, gets, replaces, updates, and deletes documents", async () => {
    const created = await db.dataCreate("users", { name: "Ada", age: 36 });
    expect(created.ok).toBe(true);
    expect(created.id).toBeTruthy();

    const got = await db.dataGet("users", created.id);
    expect(got).toMatchObject({ found: true });
    expect(got.document).toMatchObject({ _id: created.id, name: "Ada", age: 36 });

    const replaced = await db.dataReplace("users", created.id, { name: "Ada L" });
    expect(replaced).toMatchObject({ ok: true, id: created.id, matchedCount: 1, modifiedCount: 1 });
    expect((await db.dataGet("users", created.id)).document).toEqual({ _id: created.id, name: "Ada L" });

    const updated = await db.dataUpdate("users", created.id, {
      $set: { city: "London" },
      $inc: { logins: 1 },
      $push: { tags: "admin" },
    });
    expect(updated).toMatchObject({ matchedCount: 1, modifiedCount: 1 });
    expect((await db.dataGet("users", created.id)).document).toMatchObject({
      city: "London",
      logins: 1,
      tags: ["admin"],
    });

    await db.dataUpdate("users", created.id, { $pull: { tags: "admin" }, $unset: { city: "" } });
    const afterPull = (await db.dataGet("users", created.id)).document!;
    expect(afterPull.tags).toEqual([]);
    expect(afterPull).not.toHaveProperty("city");

    expect(await db.dataDelete("users", created.id)).toEqual({ deleted: true, deletedCount: 1 });
    expect(await db.dataGet("users", created.id)).toEqual({ document: null, found: false });
  });

  it("honors custom _id and rejects duplicates", async () => {
    await db.dataCreate("users", { _id: "u1", name: "Ada" });
    await expect(db.dataCreate("users", { _id: "u1", name: "Grace" })).rejects.toMatchObject({
      code: "DATA_DUPLICATE_KEY",
      status: 409,
    });
  });

  it("finds, counts, sorts, projects, and paginates documents", async () => {
    for (let i = 0; i < 10; i++) {
      await db.dataCreate("nums", { _id: `n${i}`, i, even: i % 2 === 0, name: `item-${i}`, nested: { rank: i } });
    }

    expect((await db.dataFind("nums", { filter: { i: { $gte: 8 } } })).total).toBe(2);
    expect((await db.dataFind("nums", { filter: { i: { $in: [1, 3] } } })).total).toBe(2);
    expect((await db.dataFind("nums", { filter: { $or: [{ i: 0 }, { i: 9 }] } })).total).toBe(2);
    expect((await db.dataFind("nums", { filter: { name: { $regex: "^item-1$" } } })).total).toBe(1);
    expect(await db.dataCount("nums", { even: true })).toEqual({ count: 5 });

    const page1 = await db.dataFind("nums", { sort: { i: -1 }, limit: 4, projection: { i: 1, _id: 0 } });
    expect(page1.documents.map((d) => d.i)).toEqual([9, 8, 7, 6]);
    expect(page1.documents[0]).not.toHaveProperty("_id");
    expect(page1.documents[0]).not.toHaveProperty("name");
    expect(page1.cursor).toBe("4");

    const page2 = await db.dataFind("nums", { sort: { i: -1 }, limit: 4, cursor: page1.cursor });
    expect(page2.documents.map((d) => d.i)).toEqual([5, 4, 3, 2]);
  });

  it("runs bulk operations and respects ordered error handling", async () => {
    const ordered = await db.dataBulk("bulk", [
      { op: "insert", document: { _id: "1", v: 1 } },
      { op: "update", id: "1", update: { $inc: { v: 2 } } },
      { op: "insert", document: { _id: "1" } },
      { op: "delete", id: "1" },
    ]);
    expect(ordered).toMatchObject({ insertedCount: 1, modifiedCount: 1, deletedCount: 0, errorCount: 1 });
    expect((await db.dataGet("bulk", "1")).found).toBe(true);

    const unordered = await db.dataBulk("bulk2", [
      { op: "insert", document: { _id: "1", v: 1 } },
      { op: "insert", document: { _id: "1" } },
      { op: "delete", id: "1" },
    ], false);
    expect(unordered).toMatchObject({ insertedCount: 1, deletedCount: 1, errorCount: 1 });
    expect((await db.dataGet("bulk2", "1")).found).toBe(false);
  });

  it("records/list/drops indexes and lists/drops collections", async () => {
    await db.dataCreate("ix", { _id: "a", email: "a@example.com" });
    await expect(db.dataCreateIndex("ix", { name: "email_u", fields: { email: 1 }, unique: true })).resolves.toEqual({ ok: true, name: "email_u" });
    expect(await db.dataListIndexes("ix")).toEqual({ indexes: [{ name: "email_u", fields: { email: 1 }, unique: true }] });
    expect(await db.dataDropIndex("ix", "email_u")).toEqual({ ok: true, name: "email_u" });
    await expect(db.dataDropIndex("ix", "missing")).rejects.toBeInstanceOf(PortError);

    await db.dataCreate("other", { x: 1 });
    expect((await db.dataListCollections()).collections.map((c) => c.name).sort()).toEqual(["ix", "other"]);
    expect(await db.dataDropCollection("ix")).toEqual({ ok: true, collection: "ix" });
    expect((await db.dataListCollections()).collections.map((c) => c.name)).toEqual(["other"]);
    expect((await db.dataHealth()).ok).toBe(true);
  });

  it("persists documents on disk", async () => {
    await db.dataCreate("persist", { _id: "p1", value: 42 });
    await db.close();
    db = new PgliteBackend(dir);
    expect((await db.dataGet("persist", "p1")).document).toMatchObject({ value: 42 });
  });
});

describe("cache port", () => {
  it("sets, gets, checks existence, reads TTL, and deletes", async () => {
    expect(await db.cacheSet("session:a", { userId: "u1" }, 60)).toEqual({ ok: true, key: "session:a", ttl: 60 });
    expect(await db.cacheGet("session:a")).toEqual({ value: { userId: "u1" }, found: true });
    expect(await db.cacheExists("session:a")).toEqual({ exists: true });
    expect((await db.cacheTtl("session:a")).ttl).toBeGreaterThan(0);
    expect(await db.cacheDelete("session:a")).toEqual({ deleted: true });
    expect(await db.cacheGet("session:a")).toEqual({ value: null, found: false });
    expect(await db.cacheTtl("session:a")).toEqual({ ttl: -2 });
  });

  it("increments and decrements numeric values while preserving TTL", async () => {
    await db.cacheSet("hits", 1, 60);
    expect(await db.cacheIncr("hits", 2)).toEqual({ value: 3 });
    expect(await db.cacheDecr("hits")).toEqual({ value: 2 });
    expect((await db.cacheTtl("hits")).ttl).toBeGreaterThan(0);
  });

  it("expires TTL values and rejects non-number increments", async () => {
    await db.cacheSet("short", "gone", 1);
    await new Promise((resolve) => setTimeout(resolve, 1200));
    expect(await db.cacheGet("short")).toEqual({ value: null, found: false });

    await db.cacheSet("not-number", { n: 1 });
    await expect(db.cacheIncr("not-number")).rejects.toMatchObject({ code: "NOT_A_NUMBER" });
  });

  it("rejects values larger than 1MB", async () => {
    await expect(db.cacheSet("large", "x".repeat(1024 * 1024 + 1))).rejects.toMatchObject({
      code: "VALUE_TOO_LARGE",
      status: 413,
    });
  });
});

describe("blob port", () => {
  it("puts and gets text and base64 blobs", async () => {
    const putText = await db.blobPutText("notes/hello.txt", "hello", "text/plain", { source: "test" });
    expect(putText).toMatchObject({ ok: true, key: "notes/hello.txt", size: 5 });
    expect(await db.blobGetText("notes/hello.txt")).toEqual({ text: "hello", contentType: "text/plain" });

    const image = Buffer.from([1, 2, 3]).toString("base64");
    await db.blobPutBase64("bin/blob.bin", image, "application/octet-stream");
    expect(await db.blobGetBase64("bin/blob.bin")).toEqual({ contentBase64: image, contentType: "application/octet-stream" });
  });

  it("returns metadata, lists, copies, signs, and deletes blobs", async () => {
    await db.blobPutText("docs/a.txt", "a");
    await db.blobPutText("docs/b.txt", "bb");
    await db.blobPutText("img/c.png", "ccc", "image/png");

    const meta = await db.blobMeta("docs/b.txt");
    expect(meta).toMatchObject({ key: "docs/b.txt", size: 2, contentType: "text/plain" });
    expect(meta.etag).toBeTruthy();

    const listed = await db.blobList({ prefix: "docs/", limit: 1 });
    expect(listed.total).toBe(2);
    expect(listed.files).toHaveLength(1);
    expect(listed.cursor).toBe("1");

    expect(await db.blobCopy("docs/b.txt", "docs/copy.txt", { copied: "yes" })).toMatchObject({ key: "docs/copy.txt", size: 2 });
    expect((await db.blobSign("docs/copy.txt", "get", { expiresIn: 10 })).method).toBe("GET");

    expect(await db.blobDelete("docs/a.txt")).toEqual({ deleted: true });
    await expect(db.blobMeta("docs/a.txt")).rejects.toMatchObject({ code: "BLOB_FILE_NOT_FOUND" });
  });
});

describe("queue port", () => {
  it("creates, lists, publishes to, and deletes topics", async () => {
    expect(await db.queueCreateTopic("jobs", 2, 1, { retention: "1d" })).toEqual({ ok: true, topic: "jobs" });
    expect((await db.queueListTopics()).topics).toEqual([{ name: "jobs", partitions: 2, replicationFactor: 1, messageCount: 0 }]);

    expect(await db.queuePublish("jobs", { key: "k1", value: { task: "one" }, headers: { trace: "t1" }, partition: 0 })).toMatchObject({ ok: true, topic: "jobs", partition: 0, offset: 0 });
    expect(await db.queuePublishBatch("jobs", [{ value: "two" }, { value: "three" }])).toMatchObject({ ok: true, topic: "jobs" });
    expect((await db.queueListTopics("jo")).topics[0].messageCount).toBe(3);

    expect(await db.queueDeleteTopic("jobs")).toEqual({ deleted: true, topic: "jobs" });
    expect((await db.queueListTopics()).topics).toEqual([]);
  });

  it("subscribes, polls, acknowledges, nacks, and seeks offsets", async () => {
    await db.queuePublish("events", { value: { n: 1 } });
    await db.queuePublish("events", { value: { n: 2 } });

    const latest = await db.queueSubscribe("events", "latest-group", false, "latest");
    expect((await db.queuePoll("events", latest.subscriptionId)).messages).toEqual([]);

    const sub = await db.queueSubscribe("events", "workers", false, "earliest");
    const firstPoll = await db.queuePoll("events", sub.subscriptionId, 1);
    expect(firstPoll.messages).toHaveLength(1);
    expect(firstPoll.messages[0]).toMatchObject({ topic: "events", offset: 0, value: { n: 1 } });
    expect(firstPoll.hasMore).toBe(true);

    // Without ack, manual subscriptions see the same offset again.
    expect((await db.queuePoll("events", sub.subscriptionId, 1)).messages[0].offset).toBe(0);
    expect(await db.queueAck("events", sub.subscriptionId, 0, 0)).toMatchObject({ ok: true, offset: 0 });
    expect((await db.queuePoll("events", sub.subscriptionId, 1)).messages[0].offset).toBe(1);
    expect(await db.queueNack("events", sub.subscriptionId, 0, 1, "retry later")).toMatchObject({ ok: true, reason: "retry later" });

    expect(await db.queueSeek("events", sub.subscriptionId, 0, "earliest")).toMatchObject({ ok: true, offset: 0 });
    expect((await db.queuePoll("events", sub.subscriptionId, 2)).messages.map((m: any) => m.offset)).toEqual([0, 1]);
    expect(await db.queueSeek("events", sub.subscriptionId, 0, "latest")).toMatchObject({ ok: true, offset: 2 });
    expect((await db.queuePoll("events", sub.subscriptionId)).messages).toEqual([]);
  });

  it("auto-commits subscriptions and limits batch size", async () => {
    await db.queuePublish("auto", { value: "a" });
    const sub = await db.queueSubscribe("auto", "g", true, "earliest");
    expect((await db.queuePoll("auto", sub.subscriptionId)).messages).toHaveLength(1);
    expect((await db.queuePoll("auto", sub.subscriptionId)).messages).toEqual([]);

    await expect(db.queuePublishBatch("too-many", Array.from({ length: 1001 }, (_, i) => ({ value: i })))).rejects.toMatchObject({ code: "QUEUE_BATCH_TOO_LARGE" });
  });
});

describe("search port", () => {
  it("creates indexes, indexes/gets/updates/deletes docs, and reports health/count", async () => {
    expect(await db.searchCreateIndex("docs", { properties: { title: { type: "text" } } }, { shards: 1 })).toMatchObject({ ok: true, index: "docs", acknowledged: true });
    expect(await db.searchIndexDoc("docs", { title: "Hello ScoutOS", status: "draft" }, "d1")).toMatchObject({ ok: true, id: "d1", result: "created", version: 1 });
    expect(await db.searchGetDoc("docs", "d1")).toMatchObject({ found: true, id: "d1", document: { title: "Hello ScoutOS", status: "draft" }, version: 1 });
    expect(await db.searchIndexDoc("docs", { title: "Hello Hyper MCP", status: "published" }, "d1")).toMatchObject({ result: "updated", version: 2 });
    expect(await db.searchHealth("docs")).toMatchObject({ status: "green", index: "docs", shardCount: 1, documentCount: 1 });
    expect(await db.searchCount("docs")).toEqual({ ok: true, index: "docs", count: 1 });
    expect(await db.searchDeleteDoc("docs", "d1")).toEqual({ deleted: true, id: "d1", index: "docs" });
    expect(await db.searchGetDoc("docs", "d1")).toEqual({ found: false, id: "d1", index: "docs", document: null, version: 0 });
  });

  it("queries using simple text, match, term, match_all, and pagination", async () => {
    await db.searchIndexDoc("docs", { title: "Alpha ScoutOS", status: "published", n: 1 }, "a");
    await db.searchIndexDoc("docs", { title: "Beta Hyper MCP", status: "draft", n: 2 }, "b");
    await db.searchIndexDoc("docs", { title: "Gamma ScoutOS", status: "published", n: 3 }, "c");

    expect((await db.searchQuery("docs", { q: "scoutos" })).hits.map((h: any) => h.id).sort()).toEqual(["a", "c"]);
    expect((await db.searchQuery("docs", { query: { match: { title: "hyper" } } })).hits.map((h: any) => h.id)).toEqual(["b"]);
    expect((await db.searchQuery("docs", { query: { term: { status: "published" } } })).total).toBe(2);

    const page = await db.searchQuery("docs", { query: { match_all: {} }, from: 1, size: 1 });
    expect(page.total).toBe(3);
    expect(page.hits).toHaveLength(1);
  });

  it("runs bulk operations and deletes indexes", async () => {
    const bulk = await db.searchBulk("bulk", [
      { action: "index", id: "1", document: { title: "one" } },
      { action: "index", id: "2", document: { title: "two" } },
      { action: "delete", id: "1" },
    ]);
    expect(bulk).toMatchObject({ ok: true, index: "bulk", errors: 0 });
    expect((await db.searchQuery("bulk", { query: { match_all: {} } })).hits.map((h: any) => h.id)).toEqual(["2"]);

    await expect(db.searchBulk("bulk", Array.from({ length: 1001 }, (_, i) => ({ action: "index", id: String(i), document: {} })))).rejects.toMatchObject({ code: "SEARCH_BULK_TOO_LARGE" });
    expect(await db.searchDeleteIndex("bulk")).toEqual({ deleted: true, index: "bulk" });
    expect(await db.searchCount("bulk")).toEqual({ ok: true, index: "bulk", count: 0 });
  });
});

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
    const created = await db.dataCreate(undefined, "users", { name: "Ada", age: 36 });
    expect(created.ok).toBe(true);
    expect(created.id).toBeTruthy();

    const got = await db.dataGet(undefined, "users", created.id);
    expect(got).toMatchObject({ found: true });
    expect(got.document).toMatchObject({ _id: created.id, name: "Ada", age: 36 });

    const replaced = await db.dataReplace(undefined, "users", created.id, { name: "Ada L" });
    expect(replaced).toMatchObject({ ok: true, id: created.id, matchedCount: 1, modifiedCount: 1 });
    expect((await db.dataGet(undefined, "users", created.id)).document).toEqual({ _id: created.id, name: "Ada L" });

    const updated = await db.dataUpdate(undefined, "users", created.id, {
      $set: { city: "London" },
      $inc: { logins: 1 },
      $push: { tags: "admin" },
    });
    expect(updated).toMatchObject({ matchedCount: 1, modifiedCount: 1 });
    expect((await db.dataGet(undefined, "users", created.id)).document).toMatchObject({
      city: "London",
      logins: 1,
      tags: ["admin"],
    });

    await db.dataUpdate(undefined, "users", created.id, { $pull: { tags: "admin" }, $unset: { city: "" } });
    const afterPull = (await db.dataGet(undefined, "users", created.id)).document!;
    expect(afterPull.tags).toEqual([]);
    expect(afterPull).not.toHaveProperty("city");

    expect(await db.dataDelete(undefined, "users", created.id)).toEqual({ deleted: true, deletedCount: 1 });
    expect(await db.dataGet(undefined, "users", created.id)).toEqual({ document: null, found: false });
  });

  it("honors custom _id and rejects duplicates", async () => {
    await db.dataCreate(undefined, "users", { _id: "u1", name: "Ada" });
    await expect(db.dataCreate(undefined, "users", { _id: "u1", name: "Grace" })).rejects.toMatchObject({
      code: "DATA_DUPLICATE_KEY",
      status: 409,
    });
  });

  it("finds, counts, sorts, projects, and paginates documents", async () => {
    for (let i = 0; i < 10; i++) {
      await db.dataCreate(undefined, "nums", { _id: `n${i}`, i, even: i % 2 === 0, name: `item-${i}`, nested: { rank: i } });
    }

    expect((await db.dataFind(undefined, "nums", { filter: { i: { $gte: 8 } } })).total).toBe(2);
    expect((await db.dataFind(undefined, "nums", { filter: { i: { $in: [1, 3] } } })).total).toBe(2);
    expect((await db.dataFind(undefined, "nums", { filter: { $or: [{ i: 0 }, { i: 9 }] } })).total).toBe(2);
    expect((await db.dataFind(undefined, "nums", { filter: { name: { $regex: "^item-1$" } } })).total).toBe(1);
    expect(await db.dataCount(undefined, "nums", { even: true })).toEqual({ count: 5 });

    const page1 = await db.dataFind(undefined, "nums", { sort: { i: -1 }, limit: 4, projection: { i: 1, _id: 0 } });
    expect(page1.documents.map((d) => d.i)).toEqual([9, 8, 7, 6]);
    expect(page1.documents[0]).not.toHaveProperty("_id");
    expect(page1.documents[0]).not.toHaveProperty("name");
    expect(page1.cursor).toBe("4");

    const page2 = await db.dataFind(undefined, "nums", { sort: { i: -1 }, limit: 4, cursor: page1.cursor });
    expect(page2.documents.map((d) => d.i)).toEqual([5, 4, 3, 2]);
  });

  it("runs bulk operations and respects ordered error handling", async () => {
    const ordered = await db.dataBulk(undefined, "bulk", [
      { op: "insert", document: { _id: "1", v: 1 } },
      { op: "update", id: "1", update: { $inc: { v: 2 } } },
      { op: "insert", document: { _id: "1" } },
      { op: "delete", id: "1" },
    ]);
    expect(ordered).toMatchObject({ insertedCount: 1, modifiedCount: 1, deletedCount: 0, errorCount: 1 });
    expect((await db.dataGet(undefined, "bulk", "1")).found).toBe(true);

    const unordered = await db.dataBulk(undefined, "bulk2", [
      { op: "insert", document: { _id: "1", v: 1 } },
      { op: "insert", document: { _id: "1" } },
      { op: "delete", id: "1" },
    ], false);
    expect(unordered).toMatchObject({ insertedCount: 1, deletedCount: 1, errorCount: 1 });
    expect((await db.dataGet(undefined, "bulk2", "1")).found).toBe(false);
  });

  it("records/list/drops indexes and lists/drops collections", async () => {
    await db.dataCreate(undefined, "ix", { _id: "a", email: "a@example.com" });
    await expect(db.dataCreateIndex(undefined, "ix", { name: "email_u", fields: { email: 1 }, unique: true })).resolves.toEqual({ ok: true, name: "email_u" });
    expect(await db.dataListIndexes(undefined, "ix")).toEqual({ indexes: [{ name: "email_u", fields: { email: 1 }, unique: true }] });
    expect(await db.dataDropIndex(undefined, "ix", "email_u")).toEqual({ ok: true, name: "email_u" });
    await expect(db.dataDropIndex(undefined, "ix", "missing")).rejects.toBeInstanceOf(PortError);

    await db.dataCreate(undefined, "other", { x: 1 });
    expect((await db.dataListCollections(undefined)).collections.map((c) => c.name).sort()).toEqual(["ix", "other"]);
    expect(await db.dataDropCollection(undefined, "ix")).toEqual({ ok: true, collection: "ix" });
    expect((await db.dataListCollections(undefined)).collections.map((c) => c.name)).toEqual(["other"]);
    expect((await db.dataHealth()).ok).toBe(true);
  });

  it("persists documents on disk", async () => {
    await db.dataCreate(undefined, "persist", { _id: "p1", value: 42 });
    await db.close();
    db = new PgliteBackend(dir);
    expect((await db.dataGet(undefined, "persist", "p1")).document).toMatchObject({ value: 42 });
  });
});

describe("cache port", () => {
  it("sets, gets, checks existence, reads TTL, and deletes", async () => {
    expect(await db.cacheSet(undefined, "session:a", { userId: "u1" }, 60)).toEqual({ ok: true, key: "session:a", ttl: 60 });
    expect(await db.cacheGet(undefined, "session:a")).toEqual({ value: { userId: "u1" }, found: true });
    expect(await db.cacheExists(undefined, "session:a")).toEqual({ exists: true });
    expect((await db.cacheTtl(undefined, "session:a")).ttl).toBeGreaterThan(0);
    expect(await db.cacheDelete(undefined, "session:a")).toEqual({ deleted: true });
    expect(await db.cacheGet(undefined, "session:a")).toEqual({ value: null, found: false });
    expect(await db.cacheTtl(undefined, "session:a")).toEqual({ ttl: -2 });
  });

  it("increments and decrements numeric values while preserving TTL", async () => {
    await db.cacheSet(undefined, "hits", 1, 60);
    expect(await db.cacheIncr(undefined, "hits", 2)).toEqual({ value: 3 });
    expect(await db.cacheDecr(undefined, "hits")).toEqual({ value: 2 });
    expect((await db.cacheTtl(undefined, "hits")).ttl).toBeGreaterThan(0);
  });

  it("expires TTL values and rejects non-number increments", async () => {
    await db.cacheSet(undefined, "short", "gone", 1);
    await new Promise((resolve) => setTimeout(resolve, 1200));
    expect(await db.cacheGet(undefined, "short")).toEqual({ value: null, found: false });

    await db.cacheSet(undefined, "not-number", { n: 1 });
    await expect(db.cacheIncr(undefined, "not-number")).rejects.toMatchObject({ code: "NOT_A_NUMBER" });
  });

  it("rejects values larger than 1MB", async () => {
    await expect(db.cacheSet(undefined, "large", "x".repeat(1024 * 1024 + 1))).rejects.toMatchObject({
      code: "VALUE_TOO_LARGE",
      status: 413,
    });
  });
});

describe("blob port", () => {
  it("puts and gets text and base64 blobs", async () => {
    const putText = await db.blobPutText(undefined, "notes/hello.txt", "hello", "text/plain", { source: "test" });
    expect(putText).toMatchObject({ ok: true, key: "notes/hello.txt", size: 5 });
    expect(await db.blobGetText(undefined, "notes/hello.txt")).toEqual({ text: "hello", contentType: "text/plain" });

    const image = Buffer.from([1, 2, 3]).toString("base64");
    await db.blobPutBase64(undefined, "bin/blob.bin", image, "application/octet-stream");
    expect(await db.blobGetBase64(undefined, "bin/blob.bin")).toEqual({ contentBase64: image, contentType: "application/octet-stream" });
  });

  it("returns metadata, lists, copies, signs, and deletes blobs", async () => {
    await db.blobPutText(undefined, "docs/a.txt", "a");
    await db.blobPutText(undefined, "docs/b.txt", "bb");
    await db.blobPutText(undefined, "img/c.png", "ccc", "image/png");

    const meta = await db.blobMeta(undefined, "docs/b.txt");
    expect(meta).toMatchObject({ key: "docs/b.txt", size: 2, contentType: "text/plain" });
    expect(meta.etag).toBeTruthy();

    const listed = await db.blobList(undefined, { prefix: "docs/", limit: 1 });
    expect(listed.total).toBe(2);
    expect(listed.files).toHaveLength(1);
    expect(listed.cursor).toBe("1");

    expect(await db.blobCopy(undefined, "docs/b.txt", "docs/copy.txt", { copied: "yes" })).toMatchObject({ key: "docs/copy.txt", size: 2 });
    expect((await db.blobSign(undefined, "docs/copy.txt", "get", { expiresIn: 10 })).method).toBe("GET");

    expect(await db.blobDelete(undefined, "docs/a.txt")).toEqual({ deleted: true });
    await expect(db.blobMeta(undefined, "docs/a.txt")).rejects.toMatchObject({ code: "BLOB_FILE_NOT_FOUND" });
  });
});

describe("queue port", () => {
  it("creates, lists, publishes to, and deletes topics", async () => {
    expect(await db.queueCreateTopic(undefined, "jobs", 2, 1, { retention: "1d" })).toEqual({ ok: true, topic: "jobs" });
    expect((await db.queueListTopics(undefined, )).topics).toEqual([{ name: "jobs", partitions: 2, replicationFactor: 1, messageCount: 0 }]);

    expect(await db.queuePublish(undefined, "jobs", { key: "k1", value: { task: "one" }, headers: { trace: "t1" }, partition: 0 })).toMatchObject({ ok: true, topic: "jobs", partition: 0, offset: 0 });
    expect(await db.queuePublishBatch(undefined, "jobs", [{ value: "two" }, { value: "three" }])).toMatchObject({ ok: true, topic: "jobs" });
    expect((await db.queueListTopics(undefined, "jo")).topics[0].messageCount).toBe(3);

    expect(await db.queueDeleteTopic(undefined, "jobs")).toEqual({ deleted: true, topic: "jobs" });
    expect((await db.queueListTopics(undefined, )).topics).toEqual([]);
  });

  it("subscribes, polls, acknowledges, nacks, and seeks offsets", async () => {
    await db.queuePublish(undefined, "events", { value: { n: 1 } });
    await db.queuePublish(undefined, "events", { value: { n: 2 } });

    const latest = await db.queueSubscribe(undefined, "events", "latest-group", false, "latest");
    expect((await db.queuePoll(undefined, "events", latest.subscriptionId)).messages).toEqual([]);

    const sub = await db.queueSubscribe(undefined, "events", "workers", false, "earliest");
    const firstPoll = await db.queuePoll(undefined, "events", sub.subscriptionId, 1);
    expect(firstPoll.messages).toHaveLength(1);
    expect(firstPoll.messages[0]).toMatchObject({ topic: "events", offset: 0, value: { n: 1 } });
    expect(firstPoll.hasMore).toBe(true);

    // Without ack, manual subscriptions see the same offset again.
    expect((await db.queuePoll(undefined, "events", sub.subscriptionId, 1)).messages[0].offset).toBe(0);
    expect(await db.queueAck(undefined, "events", sub.subscriptionId, 0, 0)).toMatchObject({ ok: true, offset: 0 });
    expect((await db.queuePoll(undefined, "events", sub.subscriptionId, 1)).messages[0].offset).toBe(1);
    expect(await db.queueNack(undefined, "events", sub.subscriptionId, 0, 1, "retry later")).toMatchObject({ ok: true, reason: "retry later" });

    expect(await db.queueSeek(undefined, "events", sub.subscriptionId, 0, "earliest")).toMatchObject({ ok: true, offset: 0 });
    expect((await db.queuePoll(undefined, "events", sub.subscriptionId, 2)).messages.map((m: any) => m.offset)).toEqual([0, 1]);
    expect(await db.queueSeek(undefined, "events", sub.subscriptionId, 0, "latest")).toMatchObject({ ok: true, offset: 2 });
    expect((await db.queuePoll(undefined, "events", sub.subscriptionId)).messages).toEqual([]);
  });

  it("auto-commits subscriptions and limits batch size", async () => {
    await db.queuePublish(undefined, "auto", { value: "a" });
    const sub = await db.queueSubscribe(undefined, "auto", "g", true, "earliest");
    expect((await db.queuePoll(undefined, "auto", sub.subscriptionId)).messages).toHaveLength(1);
    expect((await db.queuePoll(undefined, "auto", sub.subscriptionId)).messages).toEqual([]);

    await expect(db.queuePublishBatch(undefined, "too-many", Array.from({ length: 1001 }, (_, i) => ({ value: i })))).rejects.toMatchObject({ code: "QUEUE_BATCH_TOO_LARGE" });
  });
});

describe("search port", () => {
  it("creates indexes, indexes/gets/updates/deletes docs, and reports health/count", async () => {
    expect(await db.searchCreateIndex(undefined, "docs", { properties: { title: { type: "text" } } }, { shards: 1 })).toMatchObject({ ok: true, index: "docs", acknowledged: true });
    expect(await db.searchIndexDoc(undefined, "docs", { title: "Hello ScoutOS", status: "draft" }, "d1")).toMatchObject({ ok: true, id: "d1", result: "created", version: 1 });
    expect(await db.searchGetDoc(undefined, "docs", "d1")).toMatchObject({ found: true, id: "d1", document: { title: "Hello ScoutOS", status: "draft" }, version: 1 });
    expect(await db.searchIndexDoc(undefined, "docs", { title: "Hello Hyper MCP", status: "published" }, "d1")).toMatchObject({ result: "updated", version: 2 });
    expect(await db.searchHealth(undefined, "docs")).toMatchObject({ status: "green", index: "docs", shardCount: 1, documentCount: 1 });
    expect(await db.searchCount(undefined, "docs")).toEqual({ ok: true, index: "docs", count: 1 });
    expect(await db.searchDeleteDoc(undefined, "docs", "d1")).toEqual({ deleted: true, id: "d1", index: "docs" });
    expect(await db.searchGetDoc(undefined, "docs", "d1")).toEqual({ found: false, id: "d1", index: "docs", document: null, version: 0 });
  });

  it("queries using simple text, match, term, match_all, and pagination", async () => {
    await db.searchIndexDoc(undefined, "docs", { title: "Alpha ScoutOS", status: "published", n: 1 }, "a");
    await db.searchIndexDoc(undefined, "docs", { title: "Beta Hyper MCP", status: "draft", n: 2 }, "b");
    await db.searchIndexDoc(undefined, "docs", { title: "Gamma ScoutOS", status: "published", n: 3 }, "c");

    expect((await db.searchQuery(undefined, "docs", { q: "scoutos" })).hits.map((h: any) => h.id).sort()).toEqual(["a", "c"]);
    expect((await db.searchQuery(undefined, "docs", { query: { match: { title: "hyper" } } })).hits.map((h: any) => h.id)).toEqual(["b"]);
    expect((await db.searchQuery(undefined, "docs", { query: { term: { status: "published" } } })).total).toBe(2);

    const page = await db.searchQuery(undefined, "docs", { query: { match_all: {} }, from: 1, size: 1 });
    expect(page.total).toBe(3);
    expect(page.hits).toHaveLength(1);
  });

  it("runs bulk operations and deletes indexes", async () => {
    const bulk = await db.searchBulk(undefined, "bulk", [
      { action: "index", id: "1", document: { title: "one" } },
      { action: "index", id: "2", document: { title: "two" } },
      { action: "delete", id: "1" },
    ]);
    expect(bulk).toMatchObject({ ok: true, index: "bulk", errors: 0 });
    expect((await db.searchQuery(undefined, "bulk", { query: { match_all: {} } })).hits.map((h: any) => h.id)).toEqual(["2"]);

    await expect(db.searchBulk(undefined, "bulk", Array.from({ length: 1001 }, (_, i) => ({ action: "index", id: String(i), document: {} })))).rejects.toMatchObject({ code: "SEARCH_BULK_TOO_LARGE" });
    expect(await db.searchDeleteIndex(undefined, "bulk")).toEqual({ deleted: true, index: "bulk" });
    expect(await db.searchCount(undefined, "bulk")).toEqual({ ok: true, index: "bulk", count: 0 });
  });
});

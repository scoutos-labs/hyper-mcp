/**
 * Adapter conformance harness for the hyper-mcp `Ports` interface.
 *
 * This module exports `runPortConformanceSuite`, which runs the full
 * data/cache/blob/queue/search behavior suite plus tenant-isolation coverage
 * against any `Ports` implementation supplied by a factory.
 *
 * How a future adapter wires in:
 *   1. Implement `Ports` from `src/ports/types.ts`.
 *   2. Create `test/conformance/<adapter>.test.ts` that calls
 *      `runPortConformanceSuite({ name, makePorts, closePorts, reopenPorts? })`.
 *   3. `makePorts` must return a fresh, isolated instance; `closePorts` must
 *      release it. `reopenPorts` is optional and enables the persistence
 *      across-reopen test (close the current instance and reopen the same
 *      store); omit it for remote/adapters without that semantics.
 *
 * The assertions here are adapter-agnostic: they exercise the `Ports` contract
 * only, never concrete classes. PGLite is the reference implementation.
 */
import { describe, expect, it, beforeEach, afterEach } from "vitest";
import { PortError } from "../../src/errors.js";
import type { Ports } from "../../src/ports/types.js";

export interface ConformanceHooks {
  name: string;
  makePorts: () => Promise<Ports>;
  closePorts: (ports: Ports) => Promise<void>;
  /** Close the current instance and reopen the same store. Enables the persistence test. */
  reopenPorts?: (ports: Ports) => Promise<Ports>;
}

export function runPortConformanceSuite(hooks: ConformanceHooks): void {
  let ports: Ports;

  beforeEachAdapter(hooks, (p) => { ports = p; });
  afterEachAdapter(hooks, () => ports);

  describe(`${hooks.name}: data port`, () => {
    it("creates, gets, replaces, updates, and deletes documents", async () => {
      const created = await ports.dataCreate(undefined, "users", { name: "Ada", age: 36 });
      expect(created.ok).toBe(true);
      expect(created.id).toBeTruthy();

      const got = await ports.dataGet(undefined, "users", created.id);
      expect(got).toMatchObject({ found: true });
      expect(got.document).toMatchObject({ _id: created.id, name: "Ada", age: 36 });

      const replaced = await ports.dataReplace(undefined, "users", created.id, { name: "Ada L" });
      expect(replaced).toMatchObject({ ok: true, id: created.id, matchedCount: 1, modifiedCount: 1 });
      expect((await ports.dataGet(undefined, "users", created.id)).document).toEqual({ _id: created.id, name: "Ada L" });

      const updated = await ports.dataUpdate(undefined, "users", created.id, {
        $set: { city: "London" },
        $inc: { logins: 1 },
        $push: { tags: "admin" },
      });
      expect(updated).toMatchObject({ matchedCount: 1, modifiedCount: 1 });
      expect((await ports.dataGet(undefined, "users", created.id)).document).toMatchObject({
        city: "London",
        logins: 1,
        tags: ["admin"],
      });

      await ports.dataUpdate(undefined, "users", created.id, { $pull: { tags: "admin" }, $unset: { city: "" } });
      const afterPull = (await ports.dataGet(undefined, "users", created.id)).document!;
      expect(afterPull.tags).toEqual([]);
      expect(afterPull).not.toHaveProperty("city");

      expect(await ports.dataDelete(undefined, "users", created.id)).toEqual({ deleted: true, deletedCount: 1 });
      expect(await ports.dataGet(undefined, "users", created.id)).toEqual({ document: null, found: false });
    });

    it("honors custom _id and rejects duplicates", async () => {
      await ports.dataCreate(undefined, "users", { _id: "u1", name: "Ada" });
      await expect(ports.dataCreate(undefined, "users", { _id: "u1", name: "Grace" })).rejects.toMatchObject({
        code: "DATA_DUPLICATE_KEY",
        status: 409,
      });
    });

    it("finds, counts, sorts, projects, and paginates documents", async () => {
      for (let i = 0; i < 10; i++) {
        await ports.dataCreate(undefined, "nums", { _id: `n${i}`, i, even: i % 2 === 0, name: `item-${i}`, nested: { rank: i } });
      }

      expect((await ports.dataFind(undefined, "nums", { filter: { i: { $gte: 8 } } })).total).toBe(2);
      expect((await ports.dataFind(undefined, "nums", { filter: { i: { $in: [1, 3] } } })).total).toBe(2);
      expect((await ports.dataFind(undefined, "nums", { filter: { $or: [{ i: 0 }, { i: 9 }] } })).total).toBe(2);
      expect((await ports.dataFind(undefined, "nums", { filter: { name: { $regex: "^item-1$" } } })).total).toBe(1);
      expect(await ports.dataCount(undefined, "nums", { even: true })).toEqual({ count: 5 });

      const page1 = await ports.dataFind(undefined, "nums", { sort: { i: -1 }, limit: 4, projection: { i: 1, _id: 0 } });
      expect(page1.documents.map((d) => d.i)).toEqual([9, 8, 7, 6]);
      expect(page1.documents[0]).not.toHaveProperty("_id");
      expect(page1.documents[0]).not.toHaveProperty("name");
      expect(page1.cursor).toBe("4");

      const page2 = await ports.dataFind(undefined, "nums", { sort: { i: -1 }, limit: 4, cursor: page1.cursor });
      expect(page2.documents.map((d) => d.i)).toEqual([5, 4, 3, 2]);
    });

    it("runs bulk operations and respects ordered error handling", async () => {
      const ordered = await ports.dataBulk(undefined, "bulk", [
        { op: "insert", document: { _id: "1", v: 1 } },
        { op: "update", id: "1", update: { $inc: { v: 2 } } },
        { op: "insert", document: { _id: "1" } },
        { op: "delete", id: "1" },
      ]);
      expect(ordered).toMatchObject({ insertedCount: 1, modifiedCount: 1, deletedCount: 0, errorCount: 1 });
      expect((await ports.dataGet(undefined, "bulk", "1")).found).toBe(true);

      const unordered = await ports.dataBulk(undefined, "bulk2", [
        { op: "insert", document: { _id: "1", v: 1 } },
        { op: "insert", document: { _id: "1" } },
        { op: "delete", id: "1" },
      ], false);
      expect(unordered).toMatchObject({ insertedCount: 1, deletedCount: 1, errorCount: 1 });
      expect((await ports.dataGet(undefined, "bulk2", "1")).found).toBe(false);
    });

    it("records/list/drops indexes and lists/drops collections", async () => {
      await ports.dataCreate(undefined, "ix", { _id: "a", email: "a@example.com" });
      await expect(ports.dataCreateIndex(undefined, "ix", { name: "email_u", fields: { email: 1 }, unique: true })).resolves.toEqual({ ok: true, name: "email_u" });
      expect(await ports.dataListIndexes(undefined, "ix")).toEqual({ indexes: [{ name: "email_u", fields: { email: 1 }, unique: true }] });
      expect(await ports.dataDropIndex(undefined, "ix", "email_u")).toEqual({ ok: true, name: "email_u" });
      await expect(ports.dataDropIndex(undefined, "ix", "missing")).rejects.toBeInstanceOf(PortError);

      await ports.dataCreate(undefined, "other", { x: 1 });
      expect((await ports.dataListCollections(undefined)).collections.map((c) => c.name).sort()).toEqual(["ix", "other"]);
      expect(await ports.dataDropCollection(undefined, "ix")).toEqual({ ok: true, collection: "ix" });
      expect((await ports.dataListCollections(undefined)).collections.map((c) => c.name)).toEqual(["other"]);
      expect((await ports.dataHealth()).ok).toBe(true);
    });

    it.skipIf(!hooks.reopenPorts)("persists documents across reopen (adapter-specific)", async () => {
      await ports.dataCreate(undefined, "persist", { _id: "p1", value: 42 });
      ports = await hooks.reopenPorts!(ports);
      expect((await ports.dataGet(undefined, "persist", "p1")).document).toMatchObject({ value: 42 });
    });
  });

  describe(`${hooks.name}: cache port`, () => {
    it("sets, gets, checks existence, reads TTL, and deletes", async () => {
      expect(await ports.cacheSet(undefined, "session:a", { userId: "u1" }, 60)).toEqual({ ok: true, key: "session:a", ttl: 60 });
      expect(await ports.cacheGet(undefined, "session:a")).toEqual({ value: { userId: "u1" }, found: true });
      expect(await ports.cacheExists(undefined, "session:a")).toEqual({ exists: true });
      expect((await ports.cacheTtl(undefined, "session:a")).ttl).toBeGreaterThan(0);
      expect(await ports.cacheDelete(undefined, "session:a")).toEqual({ deleted: true });
      expect(await ports.cacheGet(undefined, "session:a")).toEqual({ value: null, found: false });
      expect(await ports.cacheTtl(undefined, "session:a")).toEqual({ ttl: -2 });
    });

    it("increments and decrements numeric values while preserving TTL", async () => {
      await ports.cacheSet(undefined, "hits", 1, 60);
      expect(await ports.cacheIncr(undefined, "hits", 2)).toEqual({ value: 3 });
      expect(await ports.cacheDecr(undefined, "hits")).toEqual({ value: 2 });
      expect((await ports.cacheTtl(undefined, "hits")).ttl).toBeGreaterThan(0);
    });

    it("expires TTL values and rejects non-number increments", async () => {
      await ports.cacheSet(undefined, "short", "gone", 1);
      await new Promise((resolve) => setTimeout(resolve, 1200));
      expect(await ports.cacheGet(undefined, "short")).toEqual({ value: null, found: false });

      await ports.cacheSet(undefined, "not-number", { n: 1 });
      await expect(ports.cacheIncr(undefined, "not-number")).rejects.toMatchObject({ code: "NOT_A_NUMBER" });
    });

    it("rejects values larger than 1MB", async () => {
      await expect(ports.cacheSet(undefined, "large", "x".repeat(1024 * 1024 + 1))).rejects.toMatchObject({
        code: "VALUE_TOO_LARGE",
        status: 413,
      });
    });
  });

  describe(`${hooks.name}: blob port`, () => {
    it("puts and gets text and base64 blobs", async () => {
      const putText = await ports.blobPutText(undefined, "notes/hello.txt", "hello", "text/plain", { source: "test" });
      expect(putText).toMatchObject({ ok: true, key: "notes/hello.txt", size: 5 });
      expect(await ports.blobGetText(undefined, "notes/hello.txt")).toEqual({ text: "hello", contentType: "text/plain" });

      const image = Buffer.from([1, 2, 3]).toString("base64");
      await ports.blobPutBase64(undefined, "bin/blob.bin", image, "application/octet-stream");
      expect(await ports.blobGetBase64(undefined, "bin/blob.bin")).toEqual({ contentBase64: image, contentType: "application/octet-stream" });
    });

    it("returns metadata, lists, copies, signs, and deletes blobs", async () => {
      await ports.blobPutText(undefined, "docs/a.txt", "a");
      await ports.blobPutText(undefined, "docs/b.txt", "bb");
      await ports.blobPutText(undefined, "img/c.png", "ccc", "image/png");

      const meta = await ports.blobMeta(undefined, "docs/b.txt");
      expect(meta).toMatchObject({ key: "docs/b.txt", size: 2, contentType: "text/plain" });
      expect(meta.etag).toBeTruthy();

      const listed = await ports.blobList(undefined, { prefix: "docs/", limit: 1 });
      expect(listed.total).toBe(2);
      expect(listed.files).toHaveLength(1);
      expect(listed.cursor).toBe("1");

      expect(await ports.blobCopy(undefined, "docs/b.txt", "docs/copy.txt", { copied: "yes" })).toMatchObject({ key: "docs/copy.txt", size: 2 });
      expect((await ports.blobSign(undefined, "docs/copy.txt", "get", { expiresIn: 10 })).method).toBe("GET");

      expect(await ports.blobDelete(undefined, "docs/a.txt")).toEqual({ deleted: true });
      await expect(ports.blobMeta(undefined, "docs/a.txt")).rejects.toMatchObject({ code: "BLOB_FILE_NOT_FOUND" });
    });
  });

  describe(`${hooks.name}: queue port`, () => {
    it("creates, lists, publishes to, and deletes topics", async () => {
      expect(await ports.queueCreateTopic(undefined, "jobs", 2, 1, { retention: "1d" })).toEqual({ ok: true, topic: "jobs" });
      expect((await ports.queueListTopics(undefined)).topics).toEqual([{ name: "jobs", partitions: 2, replicationFactor: 1, messageCount: 0 }]);

      expect(await ports.queuePublish(undefined, "jobs", { key: "k1", value: { task: "one" }, headers: { trace: "t1" }, partition: 0 })).toMatchObject({ ok: true, topic: "jobs", partition: 0, offset: 0 });
      expect(await ports.queuePublishBatch(undefined, "jobs", [{ value: "two" }, { value: "three" }])).toMatchObject({ ok: true, topic: "jobs" });
      expect((await ports.queueListTopics(undefined, "jo")).topics[0].messageCount).toBe(3);

      expect(await ports.queueDeleteTopic(undefined, "jobs")).toEqual({ deleted: true, topic: "jobs" });
      expect((await ports.queueListTopics(undefined)).topics).toEqual([]);
    });

    it("subscribes, polls, acknowledges, nacks, and seeks offsets", async () => {
      await ports.queuePublish(undefined, "events", { value: { n: 1 } });
      await ports.queuePublish(undefined, "events", { value: { n: 2 } });

      const latest = await ports.queueSubscribe(undefined, "events", "latest-group", false, "latest");
      expect((await ports.queuePoll(undefined, "events", latest.subscriptionId)).messages).toEqual([]);

      const sub = await ports.queueSubscribe(undefined, "events", "workers", false, "earliest");
      const firstPoll = await ports.queuePoll(undefined, "events", sub.subscriptionId, 1);
      expect(firstPoll.messages).toHaveLength(1);
      expect(firstPoll.messages[0]).toMatchObject({ topic: "events", offset: 0, value: { n: 1 } });
      expect(firstPoll.hasMore).toBe(true);

      expect((await ports.queuePoll(undefined, "events", sub.subscriptionId, 1)).messages[0].offset).toBe(0);
      expect(await ports.queueAck(undefined, "events", sub.subscriptionId, 0, 0)).toMatchObject({ ok: true, offset: 0 });
      expect((await ports.queuePoll(undefined, "events", sub.subscriptionId, 1)).messages[0].offset).toBe(1);
      expect(await ports.queueNack(undefined, "events", sub.subscriptionId, 0, 1, "retry later")).toMatchObject({ ok: true, reason: "retry later" });

      expect(await ports.queueSeek(undefined, "events", sub.subscriptionId, 0, "earliest")).toMatchObject({ ok: true, offset: 0 });
      expect((await ports.queuePoll(undefined, "events", sub.subscriptionId, 2)).messages.map((m: any) => m.offset)).toEqual([0, 1]);
      expect(await ports.queueSeek(undefined, "events", sub.subscriptionId, 0, "latest")).toMatchObject({ ok: true, offset: 2 });
      expect((await ports.queuePoll(undefined, "events", sub.subscriptionId)).messages).toEqual([]);
    });

    it("auto-commits subscriptions and limits batch size", async () => {
      await ports.queuePublish(undefined, "auto", { value: "a" });
      const sub = await ports.queueSubscribe(undefined, "auto", "g", true, "earliest");
      expect((await ports.queuePoll(undefined, "auto", sub.subscriptionId)).messages).toHaveLength(1);
      expect((await ports.queuePoll(undefined, "auto", sub.subscriptionId)).messages).toEqual([]);

      await expect(ports.queuePublishBatch(undefined, "too-many", Array.from({ length: 1001 }, (_, i) => ({ value: i })))).rejects.toMatchObject({ code: "QUEUE_BATCH_TOO_LARGE" });
    });
  });

  describe(`${hooks.name}: search port`, () => {
    it("creates indexes, indexes/gets/updates/deletes docs, and reports health/count", async () => {
      expect(await ports.searchCreateIndex(undefined, "docs", { properties: { title: { type: "text" } } }, { shards: 1 })).toMatchObject({ ok: true, index: "docs", acknowledged: true });
      expect(await ports.searchIndexDoc(undefined, "docs", { title: "Hello ScoutOS", status: "draft" }, "d1")).toMatchObject({ ok: true, id: "d1", result: "created", version: 1 });
      expect(await ports.searchGetDoc(undefined, "docs", "d1")).toMatchObject({ found: true, id: "d1", document: { title: "Hello ScoutOS", status: "draft" }, version: 1 });
      expect(await ports.searchIndexDoc(undefined, "docs", { title: "Hello Hyper MCP", status: "published" }, "d1")).toMatchObject({ result: "updated", version: 2 });
      expect(await ports.searchHealth(undefined, "docs")).toMatchObject({ status: "green", index: "docs", shardCount: 1, documentCount: 1 });
      expect(await ports.searchCount(undefined, "docs")).toEqual({ ok: true, index: "docs", count: 1 });
      expect(await ports.searchDeleteDoc(undefined, "docs", "d1")).toEqual({ deleted: true, id: "d1", index: "docs" });
      expect(await ports.searchGetDoc(undefined, "docs", "d1")).toEqual({ found: false, id: "d1", index: "docs", document: null, version: 0 });
    });

    it("queries using simple text, match, term, match_all, and pagination", async () => {
      await ports.searchIndexDoc(undefined, "docs", { title: "Alpha ScoutOS", status: "published", n: 1 }, "a");
      await ports.searchIndexDoc(undefined, "docs", { title: "Beta Hyper MCP", status: "draft", n: 2 }, "b");
      await ports.searchIndexDoc(undefined, "docs", { title: "Gamma ScoutOS", status: "published", n: 3 }, "c");

      expect((await ports.searchQuery(undefined, "docs", { q: "scoutos" })).hits.map((h: any) => h.id).sort()).toEqual(["a", "c"]);
      expect((await ports.searchQuery(undefined, "docs", { query: { match: { title: "hyper" } } })).hits.map((h: any) => h.id)).toEqual(["b"]);
      expect((await ports.searchQuery(undefined, "docs", { query: { term: { status: "published" } } })).total).toBe(2);

      const page = await ports.searchQuery(undefined, "docs", { query: { match_all: {} }, from: 1, size: 1 });
      expect(page.total).toBe(3);
      expect(page.hits).toHaveLength(1);
    });

    it("runs bulk operations and deletes indexes", async () => {
      const bulk = await ports.searchBulk(undefined, "bulk", [
        { action: "index", id: "1", document: { title: "one" } },
        { action: "index", id: "2", document: { title: "two" } },
        { action: "delete", id: "1" },
      ]);
      expect(bulk).toMatchObject({ ok: true, index: "bulk", errors: 0 });
      expect((await ports.searchQuery(undefined, "bulk", { query: { match_all: {} } })).hits.map((h: any) => h.id)).toEqual(["2"]);

      await expect(ports.searchBulk(undefined, "bulk", Array.from({ length: 1001 }, (_, i) => ({ action: "index", id: String(i), document: {} })))).rejects.toMatchObject({ code: "SEARCH_BULK_TOO_LARGE" });
      expect(await ports.searchDeleteIndex(undefined, "bulk")).toEqual({ deleted: true, index: "bulk" });
      expect(await ports.searchCount(undefined, "bulk")).toEqual({ ok: true, index: "bulk", count: 0 });
    });
  });

  describe(`${hooks.name}: tenant isolation — data port`, () => {
    it("isolates documents by account_id", async () => {
      await ports.dataCreate("alpha", "docs", { _id: "d1", name: "Alpha's data" });
      await ports.dataCreate("beta", "docs", { _id: "d1", name: "Beta's data" });

      expect((await ports.dataGet("alpha", "docs", "d1")).document).toMatchObject({ name: "Alpha's data" });
      expect((await ports.dataGet("beta", "docs", "d1")).document).toMatchObject({ name: "Beta's data" });

      expect((await ports.dataFind("alpha", "docs", {})).total).toBe(1);
      expect((await ports.dataFind("beta", "docs", {})).total).toBe(1);
    });

    it("same collection name exists independently per account", async () => {
      await ports.dataCreate("alpha", "users", { _id: "u1", name: "Alice" });
      await ports.dataCreate("beta", "users", { _id: "u1", name: "Bob" });

      expect((await ports.dataGet("alpha", "users", "u1")).document).toMatchObject({ name: "Alice" });
      expect((await ports.dataGet("beta", "users", "u1")).document).toMatchObject({ name: "Bob" });
    });

    it("drops are scoped to account", async () => {
      await ports.dataCreate("alpha", "shared", { _id: "s1", v: 1 });
      await ports.dataCreate("beta", "shared", { _id: "s1", v: 2 });

      await ports.dataDropCollection("alpha", "shared");
      expect((await ports.dataFind("alpha", "shared", {})).total).toBe(0);
      expect((await ports.dataFind("beta", "shared", {})).total).toBe(1);
    });
  });

  describe(`${hooks.name}: tenant isolation — cache port`, () => {
    it("isolates cache keys by account_id", async () => {
      await ports.cacheSet("alpha", "counter", 10);
      await ports.cacheSet("beta", "counter", 20);

      expect((await ports.cacheGet("alpha", "counter")).value).toBe(10);
      expect((await ports.cacheGet("beta", "counter")).value).toBe(20);

      await ports.cacheIncr("alpha", "counter", 5);
      expect((await ports.cacheGet("alpha", "counter")).value).toBe(15);
      expect((await ports.cacheGet("beta", "counter")).value).toBe(20);
    });

    it("delete only affects one account", async () => {
      await ports.cacheSet("alpha", "shared-key", "alpha-val");
      await ports.cacheSet("beta", "shared-key", "beta-val");

      await ports.cacheDelete("alpha", "shared-key");
      expect((await ports.cacheGet("alpha", "shared-key")).found).toBe(false);
      expect((await ports.cacheGet("beta", "shared-key")).found).toBe(true);
    });
  });

  describe(`${hooks.name}: tenant isolation — blob port`, () => {
    it("isolates blobs by account_id", async () => {
      await ports.blobPutText("alpha", "file.txt", "alpha content");
      await ports.blobPutText("beta", "file.txt", "beta content");

      expect((await ports.blobGetText("alpha", "file.txt")).text).toBe("alpha content");
      expect((await ports.blobGetText("beta", "file.txt")).text).toBe("beta content");
    });

    it("lists only account's blobs", async () => {
      await ports.blobPutText("alpha", "docs/a.txt", "a");
      await ports.blobPutText("beta", "docs/b.txt", "b");

      expect((await ports.blobList("alpha", { prefix: "docs/" })).total).toBe(1);
      expect((await ports.blobList("beta", { prefix: "docs/" })).total).toBe(1);
      expect((await ports.blobList("alpha", { prefix: "docs/" })).files[0].key).toBe("docs/a.txt");
      expect((await ports.blobList("beta", { prefix: "docs/" })).files[0].key).toBe("docs/b.txt");
    });
  });

  describe(`${hooks.name}: tenant isolation — queue port`, () => {
    it("isolates topics by account_id", async () => {
      await ports.queuePublish("alpha", "jobs", { value: "alpha-job" });
      await ports.queuePublish("beta", "jobs", { value: "beta-job" });

      const alphaTopics = await ports.queueListTopics("alpha");
      const betaTopics = await ports.queueListTopics("beta");
      expect(alphaTopics.topics).toHaveLength(1);
      expect(betaTopics.topics).toHaveLength(1);
      expect(alphaTopics.topics[0].messageCount).toBe(1);
      expect(betaTopics.topics[0].messageCount).toBe(1);

      const alphaSub = await ports.queueSubscribe("alpha", "jobs", "g1", false, "earliest");
      const alphaPoll = await ports.queuePoll("alpha", "jobs", alphaSub.subscriptionId);
      expect(alphaPoll.messages[0].value).toBe("alpha-job");

      const betaSub = await ports.queueSubscribe("beta", "jobs", "g2", false, "earliest");
      const betaPoll = await ports.queuePoll("beta", "jobs", betaSub.subscriptionId);
      expect(betaPoll.messages[0].value).toBe("beta-job");
    });

    it("delete topic only affects one account", async () => {
      await ports.queuePublish("alpha", "shared-topic", { value: 1 });
      await ports.queuePublish("beta", "shared-topic", { value: 2 });

      await ports.queueDeleteTopic("alpha", "shared-topic");
      expect((await ports.queueListTopics("alpha")).topics).toHaveLength(0);
      expect((await ports.queueListTopics("beta")).topics).toHaveLength(1);
    });
  });

  describe(`${hooks.name}: tenant isolation — search port`, () => {
    it("isolates search indexes by account_id", async () => {
      await ports.searchIndexDoc("alpha", "docs", { title: "Alpha doc" }, "d1");
      await ports.searchIndexDoc("beta", "docs", { title: "Beta doc" }, "d1");

      expect((await ports.searchQuery("alpha", "docs", { query: { match_all: {} } })).total).toBe(1);
      expect((await ports.searchQuery("beta", "docs", { query: { match_all: {} } })).total).toBe(1);
      expect((await ports.searchQuery("alpha", "docs", { q: "alpha" })).total).toBe(1);
      expect((await ports.searchQuery("beta", "docs", { q: "alpha" })).total).toBe(0);
    });

    it("delete index only affects one account", async () => {
      await ports.searchIndexDoc("alpha", "idx", { title: "A" }, "d1");
      await ports.searchIndexDoc("beta", "idx", { title: "B" }, "d1");

      await ports.searchDeleteIndex("alpha", "idx");
      expect((await ports.searchCount("alpha", "idx")).count).toBe(0);
      expect((await ports.searchCount("beta", "idx")).count).toBe(1);
    });
  });
}

function beforeEachAdapter(hooks: ConformanceHooks, setPorts: (p: Ports) => void) {
  beforeEach(async () => {
    setPorts(await hooks.makePorts());
  });
}
function afterEachAdapter(hooks: ConformanceHooks, getPorts: () => Ports) {
  afterEach(async () => {
    const p = getPorts();
    if (p) await hooks.closePorts(p).catch(() => undefined);
  });
}
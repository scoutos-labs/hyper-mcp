import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PgliteBackend } from "../src/pglite-backend.js";

let dir: string;
let db: PgliteBackend;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "hyper-mcp-conc-"));
  db = new PgliteBackend(dir);
});

afterEach(async () => {
  if (db) await db.close().catch(() => undefined);
  if (dir) await rm(dir, { recursive: true, force: true }).catch(() => undefined);
});

describe("cache_incr concurrency", () => {
  it("50 parallel increments produce 50 with no lost updates", async () => {
    const N = 50;
    const results = await Promise.all(
      Array.from({ length: N }, () => db.cacheIncr(undefined, "counter", 1)),
    );
    // Every call returns a value; the final value must equal N.
    const final = results[results.length - 1].value;
    // The last-resolved call is not necessarily the highest, so read the store.
    const got = await db.cacheGet(undefined, "counter");
    expect(got.found).toBe(true);
    expect(got.value).toBe(N);
    // All returned values are integers in [1, N] and unique (no lost updates).
    const values = results.map((r) => r.value).sort((a, b) => a - b);
    expect(new Set(values).size).toBe(N);
    expect(values).toEqual(Array.from({ length: N }, (_, i) => i + 1));
    void final;
  });

  it("preserves TTL across increments", async () => {
    await db.cacheSet(undefined, "ttl-counter", 0, 3600);
    const before = await db.cacheTtl(undefined, "ttl-counter");
    expect(before.ttl).toBeGreaterThan(0);

    await db.cacheIncr(undefined, "ttl-counter", 5);
    const after = await db.cacheTtl(undefined, "ttl-counter");
    expect(after.ttl).toBeGreaterThan(0);
    const got = await db.cacheGet(undefined, "ttl-counter");
    expect(got.value).toBe(5);
  });

  it("creates a missing key with value=by on first increment", async () => {
    const r = await db.cacheIncr(undefined, "fresh", 7);
    expect(r.value).toBe(7);
    const got = await db.cacheGet(undefined, "fresh");
    expect(got.value).toBe(7);
    // No TTL on a freshly incremented missing key.
    const ttl = await db.cacheTtl(undefined, "fresh");
    expect(ttl.ttl).toBe(-1);
  });
});

describe("queue_publish concurrency", () => {
  it("50 parallel publishes produce 50 unique contiguous offsets", async () => {
    const N = 50;
    await db.queueCreateTopic(undefined, "topic-c");
    const results = await Promise.all(
      Array.from({ length: N }, () => db.queuePublish(undefined, "topic-c", { value: "x" })),
    );
    const offsets = results.map((r) => r.offset).sort((a, b) => a - b);
    expect(new Set(offsets).size).toBe(N);
    expect(offsets).toEqual(Array.from({ length: N }, (_, i) => i));
  });

  it("publishes across two concurrent topics do not collide per topic", async () => {
    await db.queueCreateTopic(undefined, "t-a");
    await db.queueCreateTopic(undefined, "t-b");
    const [a, b] = await Promise.all([
      Promise.all(Array.from({ length: 20 }, () => db.queuePublish(undefined, "t-a", { value: 1 }))),
      Promise.all(Array.from({ length: 20 }, () => db.queuePublish(undefined, "t-b", { value: 2 }))),
    ]);
    const aOff = a.map((r) => r.offset).sort((x, y) => x - y);
    const bOff = b.map((r) => r.offset).sort((x, y) => x - y);
    expect(new Set(aOff).size).toBe(20);
    expect(new Set(bOff).size).toBe(20);
    expect(aOff).toEqual(Array.from({ length: 20 }, (_, i) => i));
    expect(bOff).toEqual(Array.from({ length: 20 }, (_, i) => i));
  });
});
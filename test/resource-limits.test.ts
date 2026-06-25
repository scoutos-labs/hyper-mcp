import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PgliteBackend } from "../src/pglite-backend.js";
import { loadConfig, DEFAULT_LIMITS, type ResourceLimits } from "../src/config.js";
import { PortError } from "../src/errors.js";

const TIGHT: ResourceLimits = {
  maxCacheBytes: 8,
  maxBlobBytes: 10,
  maxDataPageSize: 3,
  maxBlobListPageSize: 2,
  maxQueuePollBatch: 2,
  maxSearchPageSize: 2,
};

let dir: string;
let db: PgliteBackend;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "hyper-mcp-limits-"));
  db = new PgliteBackend(dir, TIGHT);
});

afterEach(async () => {
  if (db) await db.close().catch(() => undefined);
  if (dir) await rm(dir, { recursive: true, force: true }).catch(() => undefined);
});

describe("configurable resource limits", () => {
  it("rejects cache values exceeding maxCacheBytes", async () => {
    await expect(db.cacheSet(undefined, "small", "ok")).resolves.toBeTruthy();
    await expect(db.cacheSet(undefined, "big", { a: "too-long" })).rejects.toMatchObject({
      code: "VALUE_TOO_LARGE",
      status: 413,
    });
  });

  it("rejects blobs exceeding maxBlobBytes", async () => {
    await expect(db.blobPutText(undefined, "small.txt", "ok")).resolves.toBeTruthy();
    await expect(db.blobPutText(undefined, "big.txt", "hello world")).rejects.toMatchObject({
      code: "BLOB_FILE_TOO_LARGE",
      status: 413,
    });
  });

  it("clamps data_find limit to maxDataPageSize", async () => {
    for (let i = 0; i < 6; i++) await db.dataCreate(undefined, "nums", { i });
    const res = await db.dataFind(undefined, "nums", { limit: 9999 });
    expect(res.documents).toHaveLength(3);
    expect(res.total).toBe(6);
    // Explicit small limit below the cap is honored.
    expect((await db.dataFind(undefined, "nums", { limit: 1 })).documents).toHaveLength(1);
  });

  it("clamps blob_list limit to maxBlobListPageSize", async () => {
    for (let i = 0; i < 5; i++) await db.blobPutText(undefined, `b/${i}.txt`, "x");
    const res = await db.blobList(undefined, { prefix: "b/", limit: 9999 });
    expect(res.files).toHaveLength(2);
  });

  it("clamps queue_poll limit to maxQueuePollBatch", async () => {
    await db.queueCreateTopic(undefined, "t");
    const sub = await db.queueSubscribe(undefined, "t", "g", false, "earliest");
    for (let i = 0; i < 5; i++) await db.queuePublish(undefined, "t", { value: i });
    const res = await db.queuePoll(undefined, "t", sub.subscriptionId, 9999);
    expect(res.messages).toHaveLength(2);
  });

  it("clamps search_query size to maxSearchPageSize", async () => {
    await db.searchCreateIndex(undefined, "idx");
    for (let i = 0; i < 5; i++) await db.searchIndexDoc(undefined, "idx", { title: "doc" }, `d${i}`);
    const res = await db.searchQuery(undefined, "idx", { query: { match_all: {} }, size: 9999 });
    expect(res.hits).toHaveLength(2);
    expect(res.total).toBeGreaterThanOrEqual(5);
  });
});

describe("default limits (backward compatibility)", () => {
  it("applies DEFAULT_LIMITS when no limits arg is passed", async () => {
    const d2 = await mkdtemp(join(tmpdir(), "hyper-mcp-limits-default-"));
    const def = new PgliteBackend(d2);
    try {
      // 1 MiB cache cap: a ~12-byte value is well under the default cap.
      await expect(def.cacheSet(undefined, "k", { a: "hello" })).resolves.toBeTruthy();
      // Just over 1 MiB should be rejected under defaults too.
      const big = "x".repeat(DEFAULT_LIMITS.maxCacheBytes + 1);
      await expect(def.cacheSet(undefined, "big", big)).rejects.toBeInstanceOf(PortError);
    } finally {
      await def.close().catch(() => undefined);
      await rm(d2, { recursive: true, force: true }).catch(() => undefined);
    }
  });
});

describe("loadConfig limit parsing", () => {
  it("falls back to DEFAULT_LIMITS when env is unset", () => {
    const cfg = loadConfig({});
    expect(cfg.limits).toEqual(DEFAULT_LIMITS);
  });

  it("reads custom values from env", () => {
    const cfg = loadConfig({
      HYPER_MCP_MAX_CACHE_BYTES: "2048",
      HYPER_MCP_MAX_BLOB_BYTES: "5242880",
      HYPER_MCP_MAX_DATA_PAGE_SIZE: "50",
      HYPER_MCP_MAX_BLOB_LIST_PAGE_SIZE: "40",
      HYPER_MCP_MAX_QUEUE_POLL_BATCH: "77",
      HYPER_MCP_MAX_SEARCH_PAGE_SIZE: "66",
    });
    expect(cfg.limits).toEqual({
      maxCacheBytes: 2048,
      maxBlobBytes: 5242880,
      maxDataPageSize: 50,
      maxBlobListPageSize: 40,
      maxQueuePollBatch: 77,
      maxSearchPageSize: 66,
    });
  });

  it("rejects non-positive or non-integer values", () => {
    expect(() => loadConfig({ HYPER_MCP_MAX_CACHE_BYTES: "0" })).toThrow();
    expect(() => loadConfig({ HYPER_MCP_MAX_CACHE_BYTES: "-5" })).toThrow();
    expect(() => loadConfig({ HYPER_MCP_MAX_BLOB_BYTES: "1.5" })).toThrow();
    expect(() => loadConfig({ HYPER_MCP_MAX_BLOB_BYTES: "not-a-number" })).toThrow();
  });
});
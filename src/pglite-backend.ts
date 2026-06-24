import { createHash, randomUUID } from "node:crypto";
import { mkdir } from "node:fs/promises";
import { dirname } from "node:path";
import { PGlite } from "@electric-sql/pglite";
import { PortError } from "./errors.js";
import { applyUpdate, matchFilter, projectDoc, sortDocs, type Doc } from "./mongo.js";

const MAX_CACHE_BYTES = 1024 * 1024;
const MAX_BLOB_BYTES = 100 * 1024 * 1024;
const MAX_BULK = 1000;
const DEFAULT_ACCOUNT = "default";

export class PgliteBackend {
  private db: PGlite;
  private ready: Promise<void>;

  constructor(private dir: string) {
    this.db = new PGlite(dir);
    this.ready = this.init();
  }

  private async init(): Promise<void> {
    await mkdir(dirname(this.dir), { recursive: true });
    await this.db.exec(`
      CREATE TABLE IF NOT EXISTS data_docs (
        account_id text NOT NULL,
        collection text NOT NULL,
        id text NOT NULL,
        document jsonb NOT NULL,
        created_at timestamptz NOT NULL DEFAULT now(),
        updated_at timestamptz NOT NULL DEFAULT now(),
        PRIMARY KEY (account_id, collection, id)
      );
      CREATE TABLE IF NOT EXISTS data_indexes (
        account_id text NOT NULL,
        collection text NOT NULL,
        name text NOT NULL,
        spec jsonb NOT NULL,
        PRIMARY KEY (account_id, collection, name)
      );
      CREATE TABLE IF NOT EXISTS cache_entries (
        account_id text NOT NULL,
        key text NOT NULL,
        value jsonb NOT NULL,
        expires_at timestamptz NULL,
        updated_at timestamptz NOT NULL DEFAULT now(),
        PRIMARY KEY (account_id, key)
      );
      CREATE TABLE IF NOT EXISTS blob_objects (
        account_id text NOT NULL,
        key text NOT NULL,
        content_base64 text NOT NULL,
        content_type text NOT NULL,
        size integer NOT NULL,
        etag text NOT NULL,
        metadata jsonb,
        created_at timestamptz NOT NULL DEFAULT now(),
        updated_at timestamptz NOT NULL DEFAULT now(),
        PRIMARY KEY (account_id, key)
      );
      CREATE TABLE IF NOT EXISTS queue_topics (
        account_id text NOT NULL,
        topic text NOT NULL,
        partitions integer NOT NULL DEFAULT 1,
        replication_factor integer NOT NULL DEFAULT 1,
        config jsonb,
        created_at timestamptz NOT NULL DEFAULT now(),
        PRIMARY KEY (account_id, topic)
      );
      CREATE TABLE IF NOT EXISTS queue_messages (
        account_id text NOT NULL,
        topic text NOT NULL,
        FOREIGN KEY (account_id, topic) REFERENCES queue_topics(account_id, topic) ON DELETE CASCADE,
        partition integer NOT NULL DEFAULT 0,
        offset_id integer NOT NULL,
        id text NOT NULL,
        key text,
        value jsonb NOT NULL,
        headers jsonb,
        timestamp_ms bigint NOT NULL,
        PRIMARY KEY (account_id, topic, partition, offset_id)
      );
      CREATE TABLE IF NOT EXISTS queue_subscriptions (
        account_id text NOT NULL,
        subscription_id text PRIMARY KEY,
        topic text NOT NULL,
        group_id text NOT NULL,
        auto_commit boolean NOT NULL DEFAULT true,
        next_offset integer NOT NULL DEFAULT 0,
        created_at timestamptz NOT NULL DEFAULT now()
      );
      CREATE TABLE IF NOT EXISTS search_indexes (
        account_id text NOT NULL,
        index_name text NOT NULL,
        mapping jsonb,
        settings jsonb,
        created_at timestamptz NOT NULL DEFAULT now(),
        PRIMARY KEY (account_id, index_name)
      );
      CREATE TABLE IF NOT EXISTS search_docs (
        account_id text NOT NULL,
        index_name text NOT NULL,
        FOREIGN KEY (account_id, index_name) REFERENCES search_indexes(account_id, index_name) ON DELETE CASCADE,
        id text NOT NULL,
        document jsonb NOT NULL,
        search_text text NOT NULL,
        version integer NOT NULL DEFAULT 1,
        updated_at timestamptz NOT NULL DEFAULT now(),
        PRIMARY KEY (account_id, index_name, id)
      );

      CREATE TABLE IF NOT EXISTS accounts (
        account_id text PRIMARY KEY,
        name text,
        issuer text NOT NULL,
        audience text NOT NULL,
        status text NOT NULL DEFAULT 'active',
        scopes jsonb NOT NULL DEFAULT '[]',
        created_at timestamptz NOT NULL DEFAULT now(),
        updated_at timestamptz NOT NULL DEFAULT now()
      );
      CREATE TABLE IF NOT EXISTS account_keys (
        account_id text NOT NULL REFERENCES accounts(account_id) ON DELETE CASCADE,
        kid text NOT NULL,
        public_jwk jsonb NOT NULL,
        created_at timestamptz NOT NULL DEFAULT now(),
        PRIMARY KEY (account_id, kid)
      );
      CREATE TABLE IF NOT EXISTS account_jwks (
        account_id text NOT NULL REFERENCES accounts(account_id) ON DELETE CASCADE,
        jwks_url text NOT NULL,
        cached_jwks jsonb,
        cache_expires_at timestamptz,
        created_at timestamptz NOT NULL DEFAULT now(),
        PRIMARY KEY (account_id)
      );
      CREATE TABLE IF NOT EXISTS account_audit_log (
        id text PRIMARY KEY,
        actor text,
        account_id text,
        action text NOT NULL,
        outcome text NOT NULL,
        metadata jsonb,
        created_at timestamptz NOT NULL DEFAULT now()
      );
    `);
  }

  private async q<T>(sql: string, params: unknown[] = []) {
    await this.ready;
    return this.db.query<T>(sql, params as any[]);
  }

  private acct(a: string | undefined): string {
    return a || DEFAULT_ACCOUNT;
  }

  // Data
  async dataCreate(accountId: string | undefined, collection: string, document: Doc) {
    const aid = this.acct(accountId);
    const id = typeof document._id === "string" ? document._id : randomUUID();
    const doc = { ...structuredClone(document), _id: id };
    try {
      await this.q(`INSERT INTO data_docs(account_id,collection,id,document) VALUES ($1,$2,$3,$4::jsonb)`, [aid, collection, id, JSON.stringify(doc)]);
    } catch (e) {
      throw new PortError("DATA_DUPLICATE_KEY", `Document with _id ${id} already exists`, 409);
    }
    return { ok: true, id };
  }
  async dataGet(accountId: string | undefined, collection: string, id: string) {
    const aid = this.acct(accountId);
    const r = await this.q<{ document: Doc }>(`SELECT document FROM data_docs WHERE account_id=$1 AND collection=$2 AND id=$3`, [aid, collection, id]);
    return r.rows[0] ? { document: r.rows[0].document, found: true } : { document: null, found: false };
  }
  async dataReplace(accountId: string | undefined, collection: string, id: string, document: Doc) {
    const aid = this.acct(accountId);
    const doc = { ...structuredClone(document), _id: id };
    const r = await this.q<{ id: string }>(`UPDATE data_docs SET document=$4::jsonb, updated_at=now() WHERE account_id=$1 AND collection=$2 AND id=$3 RETURNING id`, [aid, collection, id, JSON.stringify(doc)]);
    return { ok: true, id, matchedCount: r.rows.length, modifiedCount: r.rows.length };
  }
  async dataUpdate(accountId: string | undefined, collection: string, id: string, update: Doc) {
    const got = await this.dataGet(accountId, collection, id);
    if (!got.found || !got.document) return { ok: true, id, matchedCount: 0, modifiedCount: 0 };
    const { doc, modified } = applyUpdate(got.document, update);
    const aid = this.acct(accountId);
    await this.q(`UPDATE data_docs SET document=$4::jsonb, updated_at=now() WHERE account_id=$1 AND collection=$2 AND id=$3`, [aid, collection, id, JSON.stringify(doc)]);
    return { ok: true, id, matchedCount: 1, modifiedCount: modified ? 1 : 0 };
  }
  async dataDelete(accountId: string | undefined, collection: string, id: string) {
    const aid = this.acct(accountId);
    const r = await this.q<{ id: string }>(`DELETE FROM data_docs WHERE account_id=$1 AND collection=$2 AND id=$3 RETURNING id`, [aid, collection, id]);
    return { deleted: r.rows.length > 0, deletedCount: r.rows.length };
  }
  async dataFind(accountId: string | undefined, collection: string, options: { filter?: Doc; sort?: Record<string, 1 | -1>; limit?: number; skip?: number; cursor?: string; projection?: Record<string, 0 | 1> } = {}) {
    const aid = this.acct(accountId);
    const r = await this.q<{ document: Doc }>(`SELECT document FROM data_docs WHERE account_id=$1 AND collection=$2`, [aid, collection]);
    const matched = sortDocs(r.rows.map(x => x.document).filter(d => matchFilter(d, options.filter)), options.sort);
    const total = matched.length;
    const limit = Math.min(Math.max(options.limit ?? 50, 1), 1000);
    const skip = options.cursor ? Number(options.cursor) || 0 : options.skip ?? 0;
    const page = matched.slice(skip, skip + limit).map(d => projectDoc(d, options.projection));
    const next = skip + page.length;
    return { documents: page, cursor: next < total ? String(next) : undefined, total };
  }
  async dataCount(accountId: string | undefined, collection: string, filter?: Doc) {
    return { count: (await this.dataFind(accountId, collection, { filter, limit: 1000 })).total };
  }
  async dataBulk(accountId: string | undefined, collection: string, operations: Array<any>, ordered = true) {
    if (operations.length > MAX_BULK) throw new PortError("DATA_BULK_TOO_LARGE", "Max 1000 operations", 400);
    const out = { results: [] as any[], insertedCount: 0, modifiedCount: 0, deletedCount: 0, errorCount: 0 };
    for (let i = 0; i < operations.length; i++) {
      const op = operations[i];
      try {
        if (op.op === "insert") { const r = await this.dataCreate(accountId, collection, op.document ?? {}); out.insertedCount++; out.results.push({ op: op.op, index: i, id: r.id, ok: true }); }
        else if (op.op === "update") { const r = await this.dataUpdate(accountId, collection, op.id, op.update ?? {}); out.modifiedCount += r.modifiedCount; out.results.push({ op: op.op, index: i, id: op.id, ok: true }); }
        else if (op.op === "replace") { const r = await this.dataReplace(accountId, collection, op.id, op.document ?? {}); out.modifiedCount += r.modifiedCount; out.results.push({ op: op.op, index: i, id: op.id, ok: true }); }
        else if (op.op === "delete") { const r = await this.dataDelete(accountId, collection, op.id); out.deletedCount += r.deletedCount; out.results.push({ op: op.op, index: i, id: op.id, ok: true }); }
        else throw new PortError("VALIDATION_ERROR", `Unknown op ${op.op}`, 400);
      } catch (e) { out.errorCount++; out.results.push({ op: op.op, index: i, id: op.id, ok: false, error: (e as Error).message }); if (ordered) break; }
    }
    return out;
  }
  async dataCreateIndex(accountId: string | undefined, collection: string, spec: any) {
    const aid = this.acct(accountId);
    await this.q(`INSERT INTO data_indexes(account_id,collection,name,spec) VALUES($1,$2,$3,$4::jsonb) ON CONFLICT(account_id,collection,name) DO UPDATE SET spec=excluded.spec`, [aid, collection, spec.name, JSON.stringify(spec)]);
    return { ok: true, name: spec.name };
  }
  async dataListIndexes(accountId: string | undefined, collection: string) {
    const aid = this.acct(accountId);
    const r = await this.q<{ spec: any }>(`SELECT spec FROM data_indexes WHERE account_id=$1 AND collection=$2 ORDER BY name`, [aid, collection]);
    return { indexes: r.rows.map(x => x.spec) };
  }
  async dataDropIndex(accountId: string | undefined, collection: string, name: string) {
    const aid = this.acct(accountId);
    const r = await this.q<{ name: string }>(`DELETE FROM data_indexes WHERE account_id=$1 AND collection=$2 AND name=$3 RETURNING name`, [aid, collection, name]);
    if (!r.rows.length) throw new PortError("DATA_DOCUMENT_NOT_FOUND", `Index ${name} not found`, 404);
    return { ok: true, name };
  }
  async dataListCollections(accountId: string | undefined) {
    const aid = this.acct(accountId);
    const r = await this.q<{ name: string; documentcount: number }>(`SELECT collection AS name, count(*)::int AS documentCount FROM data_docs WHERE account_id=$1 GROUP BY collection ORDER BY collection`, [aid]);
    return { collections: r.rows.map(x => ({ name: x.name, documentCount: Number((x as any).documentcount ?? (x as any).documentCount) })) };
  }
  async dataDropCollection(accountId: string | undefined, collection: string) {
    const aid = this.acct(accountId);
    await this.q(`DELETE FROM data_docs WHERE account_id=$1 AND collection=$2`, [aid, collection]);
    await this.q(`DELETE FROM data_indexes WHERE account_id=$1 AND collection=$2`, [aid, collection]);
    return { ok: true, collection };
  }
  async dataHealth() { const start = Date.now(); await this.q(`SELECT 1`); return { ok: true, latencyMs: Date.now() - start }; }

  // Cache
  private async purgeCache(accountId: string) { await this.q(`DELETE FROM cache_entries WHERE account_id=$1 AND expires_at IS NOT NULL AND expires_at <= now()`, [accountId]); }
  async cacheSet(accountId: string | undefined, key: string, value: unknown, ttl?: number) {
    const aid = this.acct(accountId);
    if (Buffer.byteLength(JSON.stringify(value ?? null)) > MAX_CACHE_BYTES) throw new PortError("VALUE_TOO_LARGE", "Value exceeds 1MB", 413);
    await this.q(`INSERT INTO cache_entries(account_id,key,value,expires_at) VALUES($1,$2,$3::jsonb, CASE WHEN $4::int IS NULL THEN NULL ELSE now() + ($4::text || ' seconds')::interval END) ON CONFLICT(account_id,key) DO UPDATE SET value=excluded.value, expires_at=excluded.expires_at, updated_at=now()`, [aid, key, JSON.stringify(value ?? null), ttl ?? null]);
    return { ok: true, key, ttl: ttl ?? null };
  }
  async cacheGet(accountId: string | undefined, key: string) {
    const aid = this.acct(accountId);
    await this.purgeCache(aid);
    const r = await this.q<{ value: unknown }>(`SELECT value FROM cache_entries WHERE account_id=$1 AND key=$2`, [aid, key]);
    return r.rows[0] ? { value: r.rows[0].value, found: true } : { value: null, found: false };
  }
  async cacheDelete(accountId: string | undefined, key: string) {
    const aid = this.acct(accountId);
    const r = await this.q<{ key: string }>(`DELETE FROM cache_entries WHERE account_id=$1 AND key=$2 RETURNING key`, [aid, key]);
    return { deleted: r.rows.length > 0 };
  }
  async cacheExists(accountId: string | undefined, key: string) { return { exists: (await this.cacheGet(accountId, key)).found }; }
  async cacheTtl(accountId: string | undefined, key: string) {
    const aid = this.acct(accountId);
    await this.purgeCache(aid);
    const r = await this.q<{ ttl: number | null }>(`SELECT CASE WHEN expires_at IS NULL THEN -1 ELSE GREATEST(0, CEIL(EXTRACT(EPOCH FROM expires_at - now())))::int END AS ttl FROM cache_entries WHERE account_id=$1 AND key=$2`, [aid, key]);
    return { ttl: r.rows[0]?.ttl ?? -2 };
  }
  async cacheIncr(accountId: string | undefined, key: string, by = 1) {
    const aid = this.acct(accountId);
    const got = await this.cacheGet(aid, key);
    const cur = got.found ? got.value : 0;
    if (typeof cur !== "number") throw new PortError("NOT_A_NUMBER", "Value is not a number", 400);
    const value = cur + by;
    if (got.found) await this.q(`UPDATE cache_entries SET value=$3::jsonb, updated_at=now() WHERE account_id=$1 AND key=$2`, [aid, key, JSON.stringify(value)]);
    else await this.cacheSet(aid, key, value);
    return { value };
  }
  async cacheDecr(accountId: string | undefined, key: string, by = 1) { return this.cacheIncr(accountId, key, -by); }

  // Blob
  async blobPutBase64(accountId: string | undefined, key: string, contentBase64: string, contentType = "application/octet-stream", metadata?: Record<string, string>) {
    const aid = this.acct(accountId);
    const buf = Buffer.from(contentBase64, "base64");
    if (buf.byteLength > MAX_BLOB_BYTES) throw new PortError("BLOB_FILE_TOO_LARGE", "Blob exceeds 100MB", 413);
    const etag = createHash("md5").update(buf).digest("hex");
    await this.q(`INSERT INTO blob_objects(account_id,key,content_base64,content_type,size,etag,metadata) VALUES($1,$2,$3,$4,$5,$6,$7::jsonb) ON CONFLICT(account_id,key) DO UPDATE SET content_base64=excluded.content_base64, content_type=excluded.content_type, size=excluded.size, etag=excluded.etag, metadata=excluded.metadata, updated_at=now()`, [aid, key, contentBase64, contentType, buf.byteLength, etag, JSON.stringify(metadata ?? null)]);
    return { ok: true, key, size: buf.byteLength, etag };
  }
  async blobPutText(accountId: string | undefined, key: string, text: string, contentType = "text/plain", metadata?: Record<string, string>) { return this.blobPutBase64(accountId, key, Buffer.from(text, "utf8").toString("base64"), contentType, metadata); }
  async blobGetBase64(accountId: string | undefined, key: string) {
    const aid = this.acct(accountId);
    const r = await this.q<any>(`SELECT content_base64 AS "contentBase64", content_type AS "contentType" FROM blob_objects WHERE account_id=$1 AND key=$2`, [aid, key]);
    if (!r.rows[0]) throw new PortError("BLOB_FILE_NOT_FOUND", `File not found: ${key}`, 404);
    return r.rows[0];
  }
  async blobGetText(accountId: string | undefined, key: string) { const r = await this.blobGetBase64(accountId, key); return { text: Buffer.from(r.contentBase64, "base64").toString("utf8"), contentType: r.contentType }; }
  async blobDelete(accountId: string | undefined, key: string) {
    const aid = this.acct(accountId);
    const r = await this.q<{ key: string }>(`DELETE FROM blob_objects WHERE account_id=$1 AND key=$2 RETURNING key`, [aid, key]);
    return { deleted: r.rows.length > 0 };
  }
  async blobMeta(accountId: string | undefined, key: string) {
    const aid = this.acct(accountId);
    const r = await this.q<any>(`SELECT key,size,content_type AS "contentType",etag,updated_at AS "lastModified",metadata FROM blob_objects WHERE account_id=$1 AND key=$2`, [aid, key]);
    if (!r.rows[0]) throw new PortError("BLOB_FILE_NOT_FOUND", `File not found: ${key}`, 404);
    return r.rows[0];
  }
  async blobList(accountId: string | undefined, options: { prefix?: string; limit?: number; cursor?: string } = {}) {
    const aid = this.acct(accountId);
    const limit = Math.min(Math.max(options.limit ?? 100, 1), 1000);
    const offset = Number(options.cursor ?? 0);
    const r = await this.q<any>(`SELECT key,size,content_type AS "contentType",updated_at AS "lastModified" FROM blob_objects WHERE account_id=$1 AND ($2::text IS NULL OR key LIKE $2 || '%') ORDER BY key LIMIT $3 OFFSET $4`, [aid, options.prefix ?? null, limit, offset]);
    const c = await this.q<{ count: number }>(`SELECT count(*)::int AS count FROM blob_objects WHERE account_id=$1 AND ($2::text IS NULL OR key LIKE $2 || '%')`, [aid, options.prefix ?? null]);
    const total = Number(c.rows[0]?.count ?? 0);
    const next = offset + r.rows.length;
    return { files: r.rows, cursor: next < total ? String(next) : undefined, total };
  }
  async blobCopy(accountId: string | undefined, sourceKey: string, destinationKey: string, metadata?: Record<string, string>) { const src = await this.blobGetBase64(accountId, sourceKey); return this.blobPutBase64(accountId, destinationKey, src.contentBase64, src.contentType, metadata); }
  async blobSign(accountId: string | undefined, key: string, action: "get" | "put", options: { expiresIn?: number } = {}) { const expiresAt = new Date(Date.now() + Math.min(options.expiresIn ?? 3600, 604800) * 1000).toISOString(); return { url: `pglite://blob/${encodeURIComponent(key)}?action=${action}`, expiresAt, method: action === "put" ? "PUT" : "GET" }; }

  // Queue
  async queueCreateTopic(accountId: string | undefined, topic: string, partitions = 1, replicationFactor = 1, config?: any) {
    const aid = this.acct(accountId);
    await this.q(`INSERT INTO queue_topics(account_id,topic,partitions,replication_factor,config) VALUES($1,$2,$3,$4,$5::jsonb) ON CONFLICT(account_id,topic) DO NOTHING`, [aid, topic, partitions, replicationFactor, JSON.stringify(config ?? null)]);
    return { ok: true, topic };
  }
  async queueListTopics(accountId: string | undefined, prefix?: string) {
    const aid = this.acct(accountId);
    const r = await this.q<any>(`SELECT t.topic AS name,t.partitions,t.replication_factor AS "replicationFactor",count(m.id)::int AS "messageCount" FROM queue_topics t LEFT JOIN queue_messages m ON m.account_id=t.account_id AND m.topic=t.topic WHERE t.account_id=$1 AND ($2::text IS NULL OR t.topic LIKE $2 || '%') GROUP BY t.topic,t.partitions,t.replication_factor ORDER BY t.topic`, [aid, prefix ?? null]);
    return { topics: r.rows };
  }
  async queueDeleteTopic(accountId: string | undefined, topic: string) {
    const aid = this.acct(accountId);
    const r = await this.q<{ topic: string }>(`DELETE FROM queue_topics WHERE account_id=$1 AND topic=$2 RETURNING topic`, [aid, topic]);
    return { deleted: r.rows.length > 0, topic };
  }
  async queuePublish(accountId: string | undefined, topic: string, msg: { key?: string; value: unknown; headers?: Record<string, string>; partition?: number }) {
    const aid = this.acct(accountId);
    await this.queueCreateTopic(aid, topic);
    const off = await this.q<{ next: number }>(`SELECT COALESCE(max(offset_id)+1,0)::int AS next FROM queue_messages WHERE account_id=$1 AND topic=$2 AND partition=$3`, [aid, topic, msg.partition ?? 0]);
    const offset = Number(off.rows[0]?.next ?? 0);
    const ts = Date.now();
    await this.q(`INSERT INTO queue_messages(account_id,topic,partition,offset_id,id,key,value,headers,timestamp_ms) VALUES($1,$2,$3,$4,$5,$6,$7::jsonb,$8::jsonb,$9)`, [aid, topic, msg.partition ?? 0, offset, randomUUID(), msg.key ?? null, JSON.stringify(msg.value), JSON.stringify(msg.headers ?? {}), ts]);
    return { ok: true, topic, partition: msg.partition ?? 0, offset, timestamp: ts };
  }
  async queuePublishBatch(accountId: string | undefined, topic: string, messages: Array<any>) {
    if (messages.length > MAX_BULK) throw new PortError("QUEUE_BATCH_TOO_LARGE", "Max 1000 messages", 400);
    const results = [];
    for (const m of messages) results.push(await this.queuePublish(accountId, topic, m));
    return { ok: true, topic, results };
  }
  async queueSubscribe(accountId: string | undefined, topic: string, groupId = "default", autoCommit = true, autoOffsetReset: "earliest" | "latest" = "latest") {
    const aid = this.acct(accountId);
    await this.queueCreateTopic(aid, topic);
    const id = randomUUID();
    const latest = await this.q<{ next: number }>(`SELECT COALESCE(max(offset_id)+1,0)::int AS next FROM queue_messages WHERE account_id=$1 AND topic=$2`, [aid, topic]);
    const next = autoOffsetReset === "latest" ? Number(latest.rows[0]?.next ?? 0) : 0;
    await this.q(`INSERT INTO queue_subscriptions(account_id,subscription_id,topic,group_id,auto_commit,next_offset) VALUES($1,$2,$3,$4,$5,$6)`, [aid, id, topic, groupId, autoCommit, next]);
    return { ok: true, subscriptionId: id, topic, groupId };
  }
  async queuePoll(accountId: string | undefined, topic: string, subscriptionId: string, limit = 100) {
    const aid = this.acct(accountId);
    const sub = await this.q<any>(`SELECT * FROM queue_subscriptions WHERE account_id=$1 AND subscription_id=$2 AND topic=$3`, [aid, subscriptionId, topic]);
    if (!sub.rows[0]) throw new PortError("QUEUE_SUBSCRIPTION_NOT_FOUND", "Subscription not found", 404);
    const next = Number(sub.rows[0].next_offset);
    const r = await this.q<any>(`SELECT id,topic,partition,offset_id AS offset,key,value,headers,timestamp_ms AS timestamp FROM queue_messages WHERE account_id=$1 AND topic=$2 AND offset_id >= $3 ORDER BY offset_id LIMIT $4`, [aid, topic, next, Math.min(limit, 10000)]);
    if (sub.rows[0].auto_commit && r.rows.length) await this.queueAck(aid, topic, subscriptionId, 0, Number(r.rows.at(-1).offset));
    return { ok: true, topic, messages: r.rows, hasMore: r.rows.length === limit };
  }
  async queueAck(accountId: string | undefined, topic: string, subscriptionId: string, partition: number, offset: number) {
    const aid = this.acct(accountId);
    await this.q(`UPDATE queue_subscriptions SET next_offset=GREATEST(next_offset,$4::int) WHERE account_id=$1 AND subscription_id=$2 AND topic=$3`, [aid, subscriptionId, topic, offset + 1]);
    return { ok: true, topic, subscriptionId, partition, offset };
  }
  async queueNack(accountId: string | undefined, topic: string, subscriptionId: string, partition: number, offset: number, reason?: string) { return { ok: true, topic, subscriptionId, partition, offset, reason }; }
  async queueSeek(accountId: string | undefined, topic: string, subscriptionId: string, partition: number, offset: number | "earliest" | "latest") {
    const aid = this.acct(accountId);
    let next = offset === "earliest" ? 0 : offset;
    if (offset === "latest") { const r = await this.q<{ next: number }>(`SELECT COALESCE(max(offset_id)+1,0)::int AS next FROM queue_messages WHERE account_id=$1 AND topic=$2`, [aid, topic]); next = Number(r.rows[0]?.next ?? 0); }
    await this.q(`UPDATE queue_subscriptions SET next_offset=$4::int WHERE account_id=$1 AND subscription_id=$2 AND topic=$3`, [aid, subscriptionId, topic, next]);
    return { ok: true, topic, subscriptionId, partition, offset: next };
  }

  // Search
  private textOf(doc: unknown) { return JSON.stringify(doc).toLowerCase(); }
  async searchCreateIndex(accountId: string | undefined, index: string, mapping?: any, settings?: any) {
    const aid = this.acct(accountId);
    await this.q(`INSERT INTO search_indexes(account_id,index_name,mapping,settings) VALUES($1,$2,$3::jsonb,$4::jsonb) ON CONFLICT(account_id,index_name) DO UPDATE SET mapping=excluded.mapping, settings=excluded.settings`, [aid, index, JSON.stringify(mapping ?? null), JSON.stringify(settings ?? null)]);
    return { ok: true, index, acknowledged: true };
  }
  async searchDeleteIndex(accountId: string | undefined, index: string) {
    const aid = this.acct(accountId);
    const r = await this.q<{ index_name: string }>(`DELETE FROM search_indexes WHERE account_id=$1 AND index_name=$2 RETURNING index_name`, [aid, index]);
    return { deleted: r.rows.length > 0, index };
  }
  async searchHealth(accountId: string | undefined, index: string) {
    const aid = this.acct(accountId);
    const r = await this.q<{ count: number }>(`SELECT count(*)::int AS count FROM search_docs WHERE account_id=$1 AND index_name=$2`, [aid, index]);
    return { status: "green", index, shardCount: 1, documentCount: Number(r.rows[0]?.count ?? 0), storeSizeBytes: 0 };
  }
  async searchIndexDoc(accountId: string | undefined, index: string, document: Doc, id: string = randomUUID(), refresh = false) {
    const aid = this.acct(accountId);
    await this.searchCreateIndex(aid, index);
    const existing = await this.q<{ version: number }>(`SELECT version FROM search_docs WHERE account_id=$1 AND index_name=$2 AND id=$3`, [aid, index, id]);
    const version = Number(existing.rows[0]?.version ?? 0) + 1;
    await this.q(`INSERT INTO search_docs(account_id,index_name,id,document,search_text,version) VALUES($1,$2,$3,$4::jsonb,$5,$6) ON CONFLICT(account_id,index_name,id) DO UPDATE SET document=excluded.document, search_text=excluded.search_text, version=search_docs.version+1, updated_at=now()`, [aid, index, id, JSON.stringify(document), this.textOf(document), version]);
    return { ok: true, id, index, result: existing.rows.length ? "updated" : "created", version };
  }
  async searchGetDoc(accountId: string | undefined, index: string, id: string) {
    const aid = this.acct(accountId);
    const r = await this.q<any>(`SELECT id,index_name AS index,document,version FROM search_docs WHERE account_id=$1 AND index_name=$2 AND id=$3`, [aid, index, id]);
    return r.rows[0] ? { found: true, ...r.rows[0] } : { found: false, id, index, document: null, version: 0 };
  }
  async searchDeleteDoc(accountId: string | undefined, index: string, id: string) {
    const aid = this.acct(accountId);
    const r = await this.q<{ id: string }>(`DELETE FROM search_docs WHERE account_id=$1 AND index_name=$2 AND id=$3 RETURNING id`, [aid, index, id]);
    return { deleted: r.rows.length > 0, id, index };
  }
  async searchBulk(accountId: string | undefined, index: string, operations: Array<any>, refresh = false) {
    if (operations.length > MAX_BULK) throw new PortError("SEARCH_BULK_TOO_LARGE", "Max 1000 operations", 400);
    const results = []; let errors = 0;
    for (const op of operations) {
      try {
        if (op.action === "delete") await this.searchDeleteDoc(accountId, index, op.id);
        else await this.searchIndexDoc(accountId, index, op.document ?? {}, op.id, refresh);
        results.push({ action: op.action, id: op.id, status: "success" });
      } catch (e) { errors++; results.push({ action: op.action, id: op.id, status: "error", error: (e as Error).message }); }
    }
    return { ok: errors === 0, index, took: 0, results, errors };
  }
  async searchQuery(accountId: string | undefined, index: string, body: any) {
    const aid = this.acct(accountId);
    const size = Math.min(Math.max(body.size ?? 100, 1), 10000);
    const from = Math.max(body.from ?? 0, 0);
    let docs = (await this.q<any>(`SELECT id,document,search_text FROM search_docs WHERE account_id=$1 AND index_name=$2`, [aid, index])).rows;
    const q = body.q ?? body.query;
    if (typeof q === "string") docs = docs.filter(d => d.search_text.includes(q.toLowerCase()));
    else if (q?.match) { const [[field, term]] = Object.entries(q.match); docs = docs.filter(d => String((d.document as any)[field] ?? "").toLowerCase().includes(String(term).toLowerCase())); }
    else if (q?.term) { const [[field, term]] = Object.entries(q.term); docs = docs.filter(d => JSON.stringify((d.document as any)[field]) === JSON.stringify(term)); }
    else if (q?.match_all) { /* all */ }
    const total = docs.length; const page = docs.slice(from, from + size);
    return { ok: true, index, took: 0, total, maxScore: null, hits: page.map(d => ({ id: d.id, score: null, source: d.document })) };
  }
  async searchCount(accountId: string | undefined, index: string) { const h = await this.searchHealth(accountId, index); return { ok: true, index, count: h.documentCount }; }

  // Auth
  async accountCreate(accountId: string, name: string, issuer: string, audience: string, scopes: string[]) {
    try {
      await this.q(`INSERT INTO accounts(account_id,name,issuer,audience,status,scopes) VALUES($1,$2,$3,$4,'active',$5::jsonb) ON CONFLICT(account_id) DO UPDATE SET name=excluded.name, issuer=excluded.issuer, audience=excluded.audience, scopes=excluded.scopes, status='active', updated_at=now()`, [accountId, name, issuer, audience, JSON.stringify(scopes)]);
    } catch (e) {
      throw new PortError("ACCOUNT_CREATE_FAILED", `Failed to create account: ${(e as Error).message}`, 400);
    }
    return { ok: true, accountId, status: "active" as const, scopes };
  }
  async accountGet(accountId: string) {
    const r = await this.q<any>(`SELECT * FROM accounts WHERE account_id=$1`, [accountId]);
    if (!r.rows[0]) return null;
    const row = r.rows[0];
    return { accountId: row.account_id, name: row.name, issuer: row.issuer, audience: row.audience, status: row.status, scopes: Array.isArray(row.scopes) ? row.scopes : JSON.parse(row.scopes || "[]") };
  }
  async accountGetByIssuer(issuer: string) {
    const r = await this.q<any>(`SELECT * FROM accounts WHERE issuer=$1 AND status='active'`, [issuer]);
    if (!r.rows[0]) return null;
    const row = r.rows[0];
    return { accountId: row.account_id, name: row.name, issuer: row.issuer, audience: row.audience, status: row.status, scopes: Array.isArray(row.scopes) ? row.scopes : JSON.parse(row.scopes || "[]") };
  }
  async accountDisable(accountId: string) {
    const r = await this.q<{ account_id: string }>(`UPDATE accounts SET status='disabled', updated_at=now() WHERE account_id=$1 RETURNING account_id`, [accountId]);
    return { ok: r.rows.length > 0, accountId };
  }
  async accountAddKey(accountId: string, kid: string, publicJwk: object) {
    await this.q(`INSERT INTO account_keys(account_id,kid,public_jwk) VALUES($1,$2,$3::jsonb) ON CONFLICT(account_id,kid) DO UPDATE SET public_jwk=excluded.public_jwk`, [accountId, kid, JSON.stringify(publicJwk)]);
    return { ok: true, accountId, kid };
  }
  async accountGetKeys(accountId: string) {
    const r = await this.q<any>(`SELECT kid, public_jwk AS "publicJwk" FROM account_keys WHERE account_id=$1`, [accountId]);
    return r.rows;
  }
  async accountAddJwksUrl(accountId: string, jwksUrl: string) {
    await this.q(`INSERT INTO account_jwks(account_id,jwks_url) VALUES($1,$2) ON CONFLICT(account_id) DO UPDATE SET jwks_url=excluded.jwks_url`, [accountId, jwksUrl]);
    return { ok: true, accountId, jwksUrl };
  }
  async accountGetJwksUrl(accountId: string) {
    const r = await this.q<any>(`SELECT jwks_url AS "jwksUrl", cached_jwks AS "cachedJwks", cache_expires_at AS "cacheExpiresAt" FROM account_jwks WHERE account_id=$1`, [accountId]);
    return r.rows[0] || null;
  }
  async accountSetCachedJwks(accountId: string, jwks: object, expiresAt: Date) {
    await this.q(`UPDATE account_jwks SET cached_jwks=$2::jsonb, cache_expires_at=$3 WHERE account_id=$1`, [accountId, JSON.stringify(jwks), expiresAt]);
  }
  async auditLogQuery(accountId: string) {
    const r = await this.q<any>(`SELECT * FROM account_audit_log WHERE account_id=$1 ORDER BY created_at DESC`, [accountId]);
    return r.rows;
  }
  async auditLog(actor: string | null, accountId: string | null, action: string, outcome: string, metadata?: Record<string, unknown>) {
    await this.q(`INSERT INTO account_audit_log(id,actor,account_id,action,outcome,metadata) VALUES($1,$2,$3,$4,$5,$6::jsonb)`, [randomUUID(), actor, accountId, action, outcome, JSON.stringify(metadata ?? null)]);
  }

  async close() { await this.ready; await this.db.close(); }
}

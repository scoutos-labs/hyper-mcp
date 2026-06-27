import { createHash, randomUUID } from "node:crypto";
import { hashPassword, verifyPassword, randomToken, sha256Hex, generateCode } from "./auth-crypto.js";
import { mkdir } from "node:fs/promises";
import { dirname } from "node:path";
import { PGlite } from "@electric-sql/pglite";
import { PortError } from "./errors.js";
import { DEFAULT_LIMITS, type ResourceLimits } from "./config.js";
import { applyUpdate, matchFilter, projectDoc, sortDocs, type Doc } from "./mongo.js";
import type { Ports } from "./ports/types.js";

const MAX_BULK = 1000;
const DEFAULT_ACCOUNT = "default";

export class PgliteBackend implements Ports {
  private db: PGlite;
  private ready: Promise<void>;

  constructor(private dir: string, private limits: ResourceLimits = DEFAULT_LIMITS, private sessionTtlSeconds: number = 86400) {
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

      CREATE TABLE IF NOT EXISTS auth_users (
        account_id text NOT NULL,
        user_id text NOT NULL,
        email text,
        username text,
        phone text,
        attributes jsonb NOT NULL DEFAULT '{}'::jsonb,
        status text NOT NULL DEFAULT 'active',
        created_at timestamptz NOT NULL DEFAULT now(),
        updated_at timestamptz NOT NULL DEFAULT now(),
        PRIMARY KEY (account_id, user_id)
      );
      CREATE UNIQUE INDEX IF NOT EXISTS auth_users_email_uq
        ON auth_users(account_id, email) WHERE email IS NOT NULL;
      CREATE UNIQUE INDEX IF NOT EXISTS auth_users_username_uq
        ON auth_users(account_id, username) WHERE username IS NOT NULL;

      CREATE TABLE IF NOT EXISTS auth_credentials (
        account_id text NOT NULL,
        user_id text NOT NULL,
        method text NOT NULL,
        hash text NOT NULL,
        updated_at timestamptz NOT NULL DEFAULT now(),
        PRIMARY KEY (account_id, user_id, method)
      );

      CREATE TABLE IF NOT EXISTS auth_sessions (
        account_id text NOT NULL,
        token_hash text NOT NULL,
        user_id text NOT NULL,
        expires_at timestamptz NOT NULL,
        created_at timestamptz NOT NULL DEFAULT now(),
        metadata jsonb,
        revoked boolean NOT NULL DEFAULT false,
        PRIMARY KEY (account_id, token_hash)
      );
      CREATE INDEX IF NOT EXISTS auth_sessions_user_idx
        ON auth_sessions(account_id, user_id);

      CREATE TABLE IF NOT EXISTS auth_codes (
        account_id text NOT NULL,
        code_id text NOT NULL,
        channel text NOT NULL,
        target text NOT NULL,
        code_hash text NOT NULL,
        user_id text,
        expires_at timestamptz NOT NULL,
        attempts integer NOT NULL DEFAULT 0,
        max_attempts integer NOT NULL DEFAULT 5,
        consumed boolean NOT NULL DEFAULT false,
        created_at timestamptz NOT NULL DEFAULT now(),
        PRIMARY KEY (account_id, code_id)
      );
      CREATE INDEX IF NOT EXISTS auth_codes_target_idx
        ON auth_codes(account_id, target);

      CREATE TABLE IF NOT EXISTS app_functions (
        account_id text NOT NULL,
        name text NOT NULL,
        body text NOT NULL,
        public boolean NOT NULL DEFAULT false,
        version integer NOT NULL DEFAULT 1,
        created_at timestamptz NOT NULL DEFAULT now(),
        updated_at timestamptz NOT NULL DEFAULT now(),
        PRIMARY KEY (account_id, name)
      );

      CREATE TABLE IF NOT EXISTS app_data (
        account_id text NOT NULL,
        user_id text NOT NULL,
        collection text NOT NULL,
        id text NOT NULL,
        document jsonb NOT NULL,
        created_at timestamptz NOT NULL DEFAULT now(),
        updated_at timestamptz NOT NULL DEFAULT now(),
        PRIMARY KEY (account_id, user_id, collection, id)
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
    const limit = Math.min(Math.max(options.limit ?? 50, 1), this.limits.maxDataPageSize);
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
    if (Buffer.byteLength(JSON.stringify(value ?? null)) > this.limits.maxCacheBytes) throw new PortError("VALUE_TOO_LARGE", `Value exceeds maxCacheBytes (${this.limits.maxCacheBytes})`, 413);
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
    // Atomic read-modify-write inside a serialized transaction so concurrent
    // increments do not lose updates. TTL (expires_at) is preserved on update.
    // Missing key: create with value=by and no TTL.
    await this.ready;
    return this.db.transaction(async (tx) => {
      const r = await tx.query<{ value: unknown }>(`SELECT value FROM cache_entries WHERE account_id=$1 AND key=$2`, [aid, key]);
      const row = r.rows[0];
      if (row) {
        const cur = row.value;
        if (typeof cur !== "number") throw new PortError("NOT_A_NUMBER", "Value is not a number", 400);
        const value = cur + by;
        await tx.query(`UPDATE cache_entries SET value=$3::jsonb, updated_at=now() WHERE account_id=$1 AND key=$2`, [aid, key, JSON.stringify(value)]);
        return { value };
      }
      const value = by;
      await tx.query(`INSERT INTO cache_entries(account_id,key,value,expires_at) VALUES($1,$2,$3::jsonb,NULL) ON CONFLICT(account_id,key) DO UPDATE SET value=excluded.value, updated_at=now()`, [aid, key, JSON.stringify(value)]);
      return { value };
    });
  }
  async cacheDecr(accountId: string | undefined, key: string, by = 1) { return this.cacheIncr(accountId, key, -by); }

  // Blob
  async blobPutBase64(accountId: string | undefined, key: string, contentBase64: string, contentType = "application/octet-stream", metadata?: Record<string, string>) {
    const aid = this.acct(accountId);
    const buf = Buffer.from(contentBase64, "base64");
    if (buf.byteLength > this.limits.maxBlobBytes) throw new PortError("BLOB_FILE_TOO_LARGE", `Blob exceeds maxBlobBytes (${this.limits.maxBlobBytes})`, 413);
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
    const limit = Math.min(Math.max(options.limit ?? 100, 1), this.limits.maxBlobListPageSize);
    const offset = Number(options.cursor ?? 0);
    const r = await this.q<any>(`SELECT key,size,content_type AS "contentType",updated_at AS "lastModified" FROM blob_objects WHERE account_id=$1 AND ($2::text IS NULL OR key LIKE $2 || '%') ORDER BY key LIMIT $3 OFFSET $4`, [aid, options.prefix ?? null, limit, offset]);
    const c = await this.q<{ count: number }>(`SELECT count(*)::int AS count FROM blob_objects WHERE account_id=$1 AND ($2::text IS NULL OR key LIKE $2 || '%')`, [aid, options.prefix ?? null]);
    const total = Number(c.rows[0]?.count ?? 0);
    const next = offset + r.rows.length;
    return { files: r.rows, cursor: next < total ? String(next) : undefined, total };
  }
  async blobCopy(accountId: string | undefined, sourceKey: string, destinationKey: string, metadata?: Record<string, string>) { const src = await this.blobGetBase64(accountId, sourceKey); return this.blobPutBase64(accountId, destinationKey, src.contentBase64, src.contentType, metadata); }
  async blobSign(accountId: string | undefined, key: string, action: "get" | "put", options: { expiresIn?: number } = {}) { const expiresAt = new Date(Date.now() + Math.min(options.expiresIn ?? 3600, 604800) * 1000).toISOString(); return { url: `pglite://blob/${encodeURIComponent(key)}?action=${action}`, expiresAt, method: action === "put" ? "PUT" as const : "GET" as const }; }

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
    // Allocate the offset and insert inside a serialized transaction so
    // concurrent publishers get unique, contiguous offsets with no collisions.
    const partition = msg.partition ?? 0;
    const ts = Date.now();
    await this.ready;
    return this.db.transaction(async (tx) => {
      const off = await tx.query<{ next: number }>(`SELECT COALESCE(max(offset_id)+1,0)::int AS next FROM queue_messages WHERE account_id=$1 AND topic=$2 AND partition=$3`, [aid, topic, partition]);
      const offset = Number(off.rows[0]?.next ?? 0);
      await tx.query(`INSERT INTO queue_messages(account_id,topic,partition,offset_id,id,key,value,headers,timestamp_ms) VALUES($1,$2,$3,$4,$5,$6,$7::jsonb,$8::jsonb,$9)`, [aid, topic, partition, offset, randomUUID(), msg.key ?? null, JSON.stringify(msg.value), JSON.stringify(msg.headers ?? {}), ts]);
      return { ok: true, topic, partition, offset, timestamp: ts };
    });
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
    const r = await this.q<any>(`SELECT id,topic,partition,offset_id AS offset,key,value,headers,timestamp_ms AS timestamp FROM queue_messages WHERE account_id=$1 AND topic=$2 AND offset_id >= $3 ORDER BY offset_id LIMIT $4`, [aid, topic, next, Math.min(limit, this.limits.maxQueuePollBatch)]);
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
    let next: number = offset === "earliest" ? 0 : (typeof offset === "number" ? offset : 0);
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
    const size = Math.min(Math.max(body.size ?? 100, 1), this.limits.maxSearchPageSize);
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
    // Enforce unique active issuer identity: no two active accounts may share
    // an issuer, otherwise JWT auth by issuer could resolve to the wrong account.
    const clash = await this.q<{ account_id: string }>(
      `SELECT account_id FROM accounts WHERE issuer=$1 AND status='active' AND account_id<>$2`,
      [issuer, accountId],
    );
    if (clash.rows.length > 0) {
      throw new PortError("ISSUER_CONFLICT", `Issuer '${issuer}' is already in use by active account '${clash.rows[0].account_id}'`, 409);
    }
    try {
      await this.q(`INSERT INTO accounts(account_id,name,issuer,audience,status,scopes) VALUES($1,$2,$3,$4,'active',$5::jsonb) ON CONFLICT(account_id) DO UPDATE SET name=excluded.name, issuer=excluded.issuer, audience=excluded.audience, scopes=excluded.scopes, status='active', updated_at=now()`, [accountId, name, issuer, audience, JSON.stringify(scopes)]);
    } catch (e) {
      // Backstop for races: a DB-level unique violation still surfaces as 409.
      const msg = (e as Error).message || "";
      if (/unique/i.test(msg)) {
        throw new PortError("ISSUER_CONFLICT", `Issuer '${issuer}' is already in use`, 409);
      }
      throw new PortError("ACCOUNT_CREATE_FAILED", `Failed to create account: ${msg}`, 400);
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
  async accountClearAuth(accountId: string) {
    await this.q(`DELETE FROM account_keys WHERE account_id=$1`, [accountId]);
    await this.q(`DELETE FROM account_jwks WHERE account_id=$1`, [accountId]);
    return { ok: true, accountId };
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

  // Auth port

  private toIso(v: unknown): string {
    if (v instanceof Date) return v.toISOString();
    return v == null ? "" : String(v);
  }

  private mapUser(row: any) {
    return {
      userId: row.user_id,
      email: row.email ?? null,
      username: row.username ?? null,
      phone: row.phone ?? null,
      attributes: typeof row.attributes === "string" ? JSON.parse(row.attributes || "{}") : (row.attributes ?? {}),
      status: row.status,
      createdAt: this.toIso(row.created_at),
      updatedAt: this.toIso(row.updated_at),
    };
  }

  async authCreateUser(accountId: string | undefined, input: any) {
    const aid = this.acct(accountId);
    const userId = randomUUID();
    const email = input.email ?? null;
    const username = input.username ?? null;
    const phone = input.phone ?? null;
    const attrs = JSON.stringify(input.attributes ?? {});
    try {
      await this.q(
        `INSERT INTO auth_users(account_id,user_id,email,username,phone,attributes) VALUES($1,$2,$3,$4,$5,$6::jsonb)`,
        [aid, userId, email, username, phone, attrs],
      );
    } catch (e) {
      const msg = (e as Error).message || "";
      if (/auth_users_email_uq|auth_users_username_uq|unique/i.test(msg)) {
        throw new PortError("AUTH_DUPLICATE", "A user with that email or username already exists in this account", 409);
      }
      throw new PortError("AUTH_CREATE_FAILED", `Failed to create user: ${msg}`, 400);
    }
    return { ok: true, userId };
  }

  async authGetUser(accountId: string | undefined, userId: string) {
    const aid = this.acct(accountId);
    const r = await this.q<any>(`SELECT * FROM auth_users WHERE account_id=$1 AND user_id=$2`, [aid, userId]);
    if (!r.rows[0]) return { user: null, found: false };
    return { user: this.mapUser(r.rows[0]), found: true };
  }

  async authFindUsers(accountId: string | undefined, query: { email?: string; username?: string }) {
    const aid = this.acct(accountId);
    const conds: string[] = [];
    const params: unknown[] = [aid];
    if (query.email) { params.push(query.email); conds.push(`email=$${params.length}`); }
    if (query.username) { params.push(query.username); conds.push(`username=$${params.length}`); }
    if (conds.length === 0) return { users: [] };
    const r = await this.q<any>(`SELECT * FROM auth_users WHERE account_id=$1 AND (${conds.join(" OR ")})`, params);
    return { users: r.rows.map((row: any) => this.mapUser(row)) };
  }

  async authUpdateUser(accountId: string | undefined, userId: string, patch: any) {
    const aid = this.acct(accountId);
    const got = await this.authGetUser(accountId, userId);
    if (!got.found || !got.user) return { ok: true, userId, matchedCount: 0 };
    const email = patch.email !== undefined ? (patch.email ?? null) : got.user.email;
    const username = patch.username !== undefined ? (patch.username ?? null) : got.user.username;
    const phone = patch.phone !== undefined ? (patch.phone ?? null) : got.user.phone;
    const status = patch.status ?? got.user.status;
    const attributes = patch.attributes
      ? { ...got.user.attributes, ...patch.attributes }
      : got.user.attributes;
    try {
      const r = await this.q<{ user_id: string }>(
        `UPDATE auth_users SET email=$3, username=$4, phone=$5, status=$6, attributes=$7::jsonb, updated_at=now() WHERE account_id=$1 AND user_id=$2 RETURNING user_id`,
        [aid, userId, email, username, phone, status, JSON.stringify(attributes)],
      );
      return { ok: true, userId, matchedCount: r.rows.length };
    } catch (e) {
      const msg = (e as Error).message || "";
      if (/auth_users_email_uq|auth_users_username_uq|unique/i.test(msg)) {
        throw new PortError("AUTH_DUPLICATE", "That email or username is already in use in this account", 409);
      }
      throw new PortError("AUTH_UPDATE_FAILED", `Failed to update user: ${msg}`, 400);
    }
  }

  async authDeleteUser(accountId: string | undefined, userId: string) {
    const aid = this.acct(accountId);
    await this.q(`DELETE FROM auth_credentials WHERE account_id=$1 AND user_id=$2`, [aid, userId]);
    await this.q(`DELETE FROM auth_sessions WHERE account_id=$1 AND user_id=$2`, [aid, userId]);
    await this.q(`DELETE FROM auth_codes WHERE account_id=$1 AND user_id=$2`, [aid, userId]);
    const r = await this.q<{ user_id: string }>(`DELETE FROM auth_users WHERE account_id=$1 AND user_id=$2 RETURNING user_id`, [aid, userId]);
    return { deleted: r.rows.length > 0 };
  }

  async authSetPassword(accountId: string | undefined, userId: string, password: string) {
    const aid = this.acct(accountId);
    const got = await this.authGetUser(accountId, userId);
    if (!got.found) throw new PortError("AUTH_USER_NOT_FOUND", `User ${userId} not found`, 404);
    const hash = await hashPassword(password);
    await this.q(
      `INSERT INTO auth_credentials(account_id,user_id,method,hash) VALUES($1,$2,'password',$3) ON CONFLICT(account_id,user_id,method) DO UPDATE SET hash=excluded.hash, updated_at=now()`,
      [aid, userId, hash],
    );
    return { ok: true, userId };
  }

  async authVerifyPassword(accountId: string | undefined, userId: string, password: string) {
    const aid = this.acct(accountId);
    const r = await this.q<{ hash: string }>(`SELECT hash FROM auth_credentials WHERE account_id=$1 AND user_id=$2 AND method='password'`, [aid, userId]);
    if (!r.rows[0]) return { valid: false };
    const valid = await verifyPassword(password, r.rows[0].hash);
    return { valid };
  }

  async authCreateSession(accountId: string | undefined, userId: string, options: { ttlSeconds?: number; metadata?: Record<string, unknown> } = {}) {
    const aid = this.acct(accountId);
    const got = await this.authGetUser(accountId, userId);
    if (!got.found) throw new PortError("AUTH_USER_NOT_FOUND", `User ${userId} not found`, 404);
    const ttl = options.ttlSeconds ?? this.sessionTtlSeconds;
    const token = randomToken(32);
    const tokenHash = sha256Hex(token);
    const expiresAt = new Date(Date.now() + ttl * 1000);
    await this.q(
      `INSERT INTO auth_sessions(account_id,token_hash,user_id,expires_at,metadata) VALUES($1,$2,$3,$4,$5::jsonb)`,
      [aid, tokenHash, userId, expiresAt, JSON.stringify(options.metadata ?? null)],
    );
    return { token, userId, expiresAt: expiresAt.toISOString() };
  }

  async authVerifySession(accountId: string | undefined, token: string) {
    const aid = this.acct(accountId);
    const tokenHash = sha256Hex(token);
    const r = await this.q<any>(`SELECT user_id, expires_at, revoked FROM auth_sessions WHERE account_id=$1 AND token_hash=$2`, [aid, tokenHash]);
    if (!r.rows[0]) return { valid: false, userId: null, expiresAt: null };
    const row = r.rows[0];
    const exp = row.expires_at instanceof Date ? row.expires_at : new Date(this.toIso(row.expires_at));
    if (row.revoked || exp.getTime() <= Date.now()) return { valid: false, userId: null, expiresAt: null };
    return { valid: true, userId: row.user_id, expiresAt: exp.toISOString() };
  }

  async authRevokeSession(accountId: string | undefined, token: string) {
    const aid = this.acct(accountId);
    const tokenHash = sha256Hex(token);
    const r = await this.q<{ token_hash: string }>(`UPDATE auth_sessions SET revoked=true WHERE account_id=$1 AND token_hash=$2 RETURNING token_hash`, [aid, tokenHash]);
    return { revoked: r.rows.length > 0 };
  }

  async authListSessions(accountId: string | undefined, userId: string) {
    const aid = this.acct(accountId);
    const r = await this.q<any>(
      `SELECT user_id, expires_at, created_at, revoked FROM auth_sessions WHERE account_id=$1 AND user_id=$2 AND revoked=false AND expires_at > now() ORDER BY created_at DESC`,
      [aid, userId],
    );
    return {
      sessions: r.rows.map((row: any) => ({
        userId: row.user_id,
        expiresAt: this.toIso(row.expires_at),
        createdAt: this.toIso(row.created_at),
        revoked: !!row.revoked,
      })),
    };
  }

  async authCreateCode(accountId: string | undefined, input: any) {
    const aid = this.acct(accountId);
    const channel = input.channel;
    const target = input.target;
    if (channel !== "email" && channel !== "sms") throw new PortError("VALIDATION_ERROR", "channel must be 'email' or 'sms'", 400);
    if (!target) throw new PortError("VALIDATION_ERROR", "target is required", 400);
    const ttl = input.ttlSeconds ?? 600;
    const maxAttempts = input.maxAttempts ?? 5;
    const code = generateCode();
    const codeId = randomUUID();
    const codeHash = sha256Hex(code);
    const expiresAt = new Date(Date.now() + ttl * 1000);
    // One active code per (account, target): remove any prior codes for this target.
    await this.q(`DELETE FROM auth_codes WHERE account_id=$1 AND target=$2`, [aid, target]);
    await this.q(
      `INSERT INTO auth_codes(account_id,code_id,channel,target,code_hash,user_id,expires_at,max_attempts) VALUES($1,$2,$3,$4,$5,$6,$7,$8)`,
      [aid, codeId, channel, target, codeHash, input.userId ?? null, expiresAt, maxAttempts],
    );
    return { code, codeId, expiresAt: expiresAt.toISOString() };
  }

  async authVerifyCode(accountId: string | undefined, query: { channel: string; target: string; code: string }) {
    const aid = this.acct(accountId);
    const r = await this.q<any>(
      `SELECT * FROM auth_codes WHERE account_id=$1 AND target=$2 AND consumed=false ORDER BY created_at DESC LIMIT 1`,
      [aid, query.target],
    );
    const row = r.rows[0];
    if (!row) return { valid: false, userId: null };
    const exp = row.expires_at instanceof Date ? row.expires_at : new Date(this.toIso(row.expires_at));
    if (exp.getTime() <= Date.now()) return { valid: false, userId: null };
    if (row.attempts >= row.max_attempts) return { valid: false, userId: null };

    const inputHash = sha256Hex(query.code);
    const expectedHash = row.code_hash;
    let match = false;
    if (inputHash.length === expectedHash.length) {
      const { timingSafeEqual } = await import("node:crypto");
      match = timingSafeEqual(Buffer.from(inputHash), Buffer.from(expectedHash));
    }

    if (!match) {
      await this.q(`UPDATE auth_codes SET attempts = attempts + 1 WHERE account_id=$1 AND code_id=$2`, [aid, row.code_id]);
      return { valid: false, userId: null };
    }

    await this.q(`UPDATE auth_codes SET consumed=true WHERE account_id=$1 AND code_id=$2`, [aid, row.code_id]);
    return { valid: true, userId: row.user_id ?? null };
  }

  async authHealth(_accountId: string | undefined) {
    const start = Date.now();
    await this.q(`SELECT 1`);
    return { ok: true, latencyMs: Date.now() - start };
  }

  // App (BaaS) port — stubs (implemented in subsequent steps)
  async appCreateFunction(accountId: string | undefined, name: string, body: string, isPublic: boolean) {
    const aid = this.acct(accountId);
    const prev = await this.q<{ version: number }>(`SELECT version FROM app_functions WHERE account_id=$1 AND name=$2`, [aid, name]);
    const version = (prev.rows[0]?.version ?? 0) + 1;
    await this.q(
      `INSERT INTO app_functions(account_id,name,body,public,version) VALUES($1,$2,$3,$4,$5)
       ON CONFLICT(account_id,name) DO UPDATE SET body=excluded.body, public=excluded.public, version=excluded.version, updated_at=now()`,
      [aid, name, body, isPublic, version],
    );
    return { ok: true, name, version };
  }
  async appGetFunction(accountId: string | undefined, name: string) {
    const aid = this.acct(accountId);
    const r = await this.q<any>(`SELECT name, body, public, version, created_at, updated_at FROM app_functions WHERE account_id=$1 AND name=$2`, [aid, name]);
    if (!r.rows[0]) return { fn: null, found: false };
    const row = r.rows[0];
    return { fn: { name: row.name, body: row.body, public: !!row.public, version: row.version, createdAt: this.toIso(row.created_at), updatedAt: this.toIso(row.updated_at) }, found: true };
  }
  async appListFunctions(accountId: string | undefined) {
    const aid = this.acct(accountId);
    const r = await this.q<any>(`SELECT name, public, version, updated_at FROM app_functions WHERE account_id=$1 ORDER BY name`, [aid]);
    return { functions: r.rows.map((row: any) => ({ name: row.name, public: !!row.public, version: row.version, updatedAt: this.toIso(row.updated_at) })) };
  }
  async appDeleteFunction(accountId: string | undefined, name: string) {
    const aid = this.acct(accountId);
    const r = await this.q<{ name: string }>(`DELETE FROM app_functions WHERE account_id=$1 AND name=$2 RETURNING name`, [aid, name]);
    return { deleted: r.rows.length > 0 };
  }
  // User-scoped app data (prototype RLS: every query is filtered by account_id AND user_id;
  // the ctx.db wrapper bakes in the userId so a function can never address another user's rows).
  async appDataCreate(accountId: string | undefined, userId: string, collection: string, document: any) {
    const aid = this.acct(accountId);
    const id = typeof document._id === "string" ? document._id : randomUUID();
    const doc = { ...structuredClone(document), _id: id };
    try {
      await this.q(`INSERT INTO app_data(account_id,user_id,collection,id,document) VALUES($1,$2,$3,$4,$5::jsonb)`, [aid, userId, collection, id, JSON.stringify(doc)]);
    } catch (e) {
      throw new PortError("APP_DATA_DUPLICATE", `Document with _id ${id} already exists`, 409);
    }
    return { ok: true, id };
  }
  async appDataGet(accountId: string | undefined, userId: string, collection: string, id: string) {
    const aid = this.acct(accountId);
    const r = await this.q<{ document: any }>(`SELECT document FROM app_data WHERE account_id=$1 AND user_id=$2 AND collection=$3 AND id=$4`, [aid, userId, collection, id]);
    return r.rows[0] ? { document: r.rows[0].document, found: true } : { document: null, found: false };
  }
  async appDataFind(accountId: string | undefined, userId: string, collection: string, options: { filter?: any; limit?: number; skip?: number } = {}) {
    const aid = this.acct(accountId);
    const r = await this.q<{ document: any }>(`SELECT document FROM app_data WHERE account_id=$1 AND user_id=$2 AND collection=$3`, [aid, userId, collection]);
    const matched = r.rows.map(x => x.document).filter((d: any) => matchFilter(d, options.filter));
    const total = matched.length;
    const limit = Math.min(Math.max(options.limit ?? 50, 1), 1000);
    const skip = options.skip ?? 0;
    return { documents: matched.slice(skip, skip + limit), total };
  }
  async appDataUpdate(accountId: string | undefined, userId: string, collection: string, id: string, patch: any) {
    const aid = this.acct(accountId);
    const got = await this.appDataGet(accountId, userId, collection, id);
    if (!got.found || !got.document) return { ok: true, id, matchedCount: 0 };
    const { doc, modified } = applyUpdate(got.document, patch);
    await this.q(`UPDATE app_data SET document=$5::jsonb, updated_at=now() WHERE account_id=$1 AND user_id=$2 AND collection=$3 AND id=$4`, [aid, userId, collection, id, JSON.stringify(doc)]);
    return { ok: true, id, matchedCount: modified ? 1 : 0 };
  }
  async appDataDelete(accountId: string | undefined, userId: string, collection: string, id: string) {
    const aid = this.acct(accountId);
    const r = await this.q<{ id: string }>(`DELETE FROM app_data WHERE account_id=$1 AND user_id=$2 AND collection=$3 AND id=$4 RETURNING id`, [aid, userId, collection, id]);
    return { deleted: r.rows.length > 0 };
  }
  async appDataCount(accountId: string | undefined, userId: string, collection: string, filter?: any) {
    const f = await this.appDataFind(accountId, userId, collection, { filter, limit: 1000 });
    return { count: f.total };
  }

  async close() { await this.ready; await this.db.close(); }
}

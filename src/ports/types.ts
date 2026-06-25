import type { Doc } from "../mongo.js";

// ---------- Shared result types ----------

export interface CacheGetResult { value: unknown; found: boolean; }
export interface CacheSetResult { ok: boolean; key: string; ttl: number | null; }
export interface FindOptions {
  filter?: Doc;
  sort?: Record<string, 1 | -1>;
  limit?: number;
  skip?: number;
  cursor?: string;
  projection?: Record<string, 0 | 1>;
}
export interface FindResult { documents: Doc[]; cursor?: string; total: number; }
export interface MutationResult { ok: boolean; id: string; matchedCount: number; modifiedCount: number; }
export interface BulkOperation { op: "insert" | "update" | "replace" | "delete"; id?: string; document?: Doc; update?: Doc; }
export interface BulkResult {
  results: Array<{ op: string; index: number; id?: string; ok: boolean; error?: string }>;
  insertedCount: number;
  modifiedCount: number;
  deletedCount: number;
  errorCount: number;
}
export interface IndexSpec { name: string; fields: Record<string, 1 | -1>; unique?: boolean; sparse?: boolean; }
export interface BlobMeta {
  key: string; size: number; contentType: string; etag: string;
  lastModified: string; cacheControl?: string; metadata?: Record<string, string>;
}
export interface BlobListOptions { prefix?: string; limit?: number; cursor?: string; includeMetadata?: boolean; }
export interface BlobListResult {
  files: Array<{ key: string; size: number; contentType?: string; lastModified?: string }>;
  cursor?: string; total: number;
}

// ---------- Data Port ----------

export interface DataPort {
  dataCreate(accountId: string | undefined, collection: string, document: Doc): Promise<{ ok: boolean; id: string }>;
  dataGet(accountId: string | undefined, collection: string, id: string): Promise<{ document: Doc | null; found: boolean }>;
  dataReplace(accountId: string | undefined, collection: string, id: string, document: Doc): Promise<MutationResult>;
  dataUpdate(accountId: string | undefined, collection: string, id: string, update: Doc): Promise<MutationResult>;
  dataDelete(accountId: string | undefined, collection: string, id: string): Promise<{ deleted: boolean; deletedCount: number }>;
  dataFind(accountId: string | undefined, collection: string, options?: FindOptions): Promise<FindResult>;
  dataCount(accountId: string | undefined, collection: string, filter?: Doc): Promise<{ count: number }>;
  dataBulk(accountId: string | undefined, collection: string, operations: BulkOperation[], ordered?: boolean): Promise<BulkResult>;
  dataCreateIndex(accountId: string | undefined, collection: string, spec: IndexSpec): Promise<{ ok: boolean; name: string }>;
  dataListIndexes(accountId: string | undefined, collection: string): Promise<{ indexes: IndexSpec[] }>;
  dataDropIndex(accountId: string | undefined, collection: string, name: string): Promise<{ ok: boolean; name: string }>;
  dataListCollections(accountId: string | undefined): Promise<{ collections: Array<{ name: string; documentCount: number }> }>;
  dataDropCollection(accountId: string | undefined, collection: string): Promise<{ ok: boolean; collection: string }>;
  dataHealth(): Promise<{ ok: boolean; latencyMs: number }>;
}

// ---------- Cache Port ----------

export interface CachePort {
  cacheSet(accountId: string | undefined, key: string, value: unknown, ttl?: number): Promise<CacheSetResult>;
  cacheGet(accountId: string | undefined, key: string): Promise<CacheGetResult>;
  cacheDelete(accountId: string | undefined, key: string): Promise<{ deleted: boolean }>;
  cacheExists(accountId: string | undefined, key: string): Promise<{ exists: boolean }>;
  cacheTtl(accountId: string | undefined, key: string): Promise<{ ttl: number }>;
  cacheIncr(accountId: string | undefined, key: string, by?: number): Promise<{ value: number }>;
  cacheDecr(accountId: string | undefined, key: string, by?: number): Promise<{ value: number }>;
}

// ---------- Blob Port ----------

export interface BlobPort {
  blobPutText(accountId: string | undefined, key: string, text: string, contentType?: string, metadata?: Record<string, string>): Promise<{ ok: boolean; key: string; size: number; etag: string }>;
  blobPutBase64(accountId: string | undefined, key: string, contentBase64: string, contentType?: string, metadata?: Record<string, string>): Promise<{ ok: boolean; key: string; size: number; etag: string }>;
  blobGetText(accountId: string | undefined, key: string): Promise<{ text: string; contentType: string }>;
  blobGetBase64(accountId: string | undefined, key: string): Promise<{ contentBase64: string; contentType: string }>;
  blobDelete(accountId: string | undefined, key: string): Promise<{ deleted: boolean }>;
  blobMeta(accountId: string | undefined, key: string): Promise<BlobMeta>;
  blobList(accountId: string | undefined, options?: BlobListOptions): Promise<BlobListResult>;
  blobCopy(accountId: string | undefined, sourceKey: string, destinationKey: string, metadata?: Record<string, string>): Promise<{ key: string; size: number; etag: string }>;
  blobSign(accountId: string | undefined, key: string, action: "get" | "put", options?: { expiresIn?: number }): Promise<{ url: string; expiresAt: string; method: "GET" | "PUT" }>;
}

// ---------- Queue Port ----------

export interface QueuePort {
  queueCreateTopic(accountId: string | undefined, topic: string, partitions?: number, replicationFactor?: number, config?: any): Promise<{ ok: boolean; topic: string }>;
  queueListTopics(accountId: string | undefined, prefix?: string): Promise<{ topics: Array<any> }>;
  queueDeleteTopic(accountId: string | undefined, topic: string): Promise<{ deleted: boolean; topic: string }>;
  queuePublish(accountId: string | undefined, topic: string, msg: { key?: string; value: unknown; headers?: Record<string, string>; partition?: number }): Promise<{ ok: boolean; topic: string; partition: number; offset: number; timestamp: number }>;
  queuePublishBatch(accountId: string | undefined, topic: string, messages: Array<any>): Promise<{ ok: boolean; topic: string; results: any[] }>;
  queueSubscribe(accountId: string | undefined, topic: string, groupId?: string, autoCommit?: boolean, autoOffsetReset?: "earliest" | "latest"): Promise<{ ok: boolean; subscriptionId: string; topic: string; groupId: string }>;
  queuePoll(accountId: string | undefined, topic: string, subscriptionId: string, limit?: number): Promise<{ ok: boolean; topic: string; messages: any[]; hasMore: boolean }>;
  queueAck(accountId: string | undefined, topic: string, subscriptionId: string, partition: number, offset: number): Promise<{ ok: boolean; topic: string; subscriptionId: string; partition: number; offset: number }>;
  queueNack(accountId: string | undefined, topic: string, subscriptionId: string, partition: number, offset: number, reason?: string): Promise<{ ok: boolean; topic: string; subscriptionId: string; partition: number; offset: number; reason?: string }>;
  queueSeek(accountId: string | undefined, topic: string, subscriptionId: string, partition: number, offset: number | "earliest" | "latest"): Promise<{ ok: boolean; topic: string; subscriptionId: string; partition: number; offset: number }>;
}

// ---------- Search Port ----------

export interface SearchPort {
  searchCreateIndex(accountId: string | undefined, index: string, mapping?: any, settings?: any): Promise<{ ok: boolean; index: string; acknowledged: boolean }>;
  searchDeleteIndex(accountId: string | undefined, index: string): Promise<{ deleted: boolean; index: string }>;
  searchHealth(accountId: string | undefined, index: string): Promise<{ status: string; index: string; shardCount: number; documentCount: number; storeSizeBytes: number }>;
  searchIndexDoc(accountId: string | undefined, index: string, document: Doc, id?: string, refresh?: boolean): Promise<{ ok: boolean; id: string; index: string; result: string; version: number }>;
  searchGetDoc(accountId: string | undefined, index: string, id: string): Promise<{ found: boolean; id: string; index: string; document: Doc | null; version: number }>;
  searchDeleteDoc(accountId: string | undefined, index: string, id: string): Promise<{ deleted: boolean; id: string; index: string }>;
  searchBulk(accountId: string | undefined, index: string, operations: Array<any>, refresh?: boolean): Promise<{ ok: boolean; index: string; took: number; results: any[]; errors: number }>;
  searchQuery(accountId: string | undefined, index: string, body: any): Promise<{ ok: boolean; index: string; took: number; total: number; maxScore: number | null; hits: any[] }>;
  searchCount(accountId: string | undefined, index: string): Promise<{ ok: boolean; index: string; count: number }>;
}


// ---------- Account Port ----------

export interface AccountInfo {
  accountId: string;
  name: string;
  issuer: string;
  audience: string;
  status: string;
  scopes: string[];
}

export interface AccountPort {
  accountCreate(accountId: string, name: string, issuer: string, audience: string, scopes: string[]): Promise<{ ok: boolean; accountId: string; status: string; scopes: string[] }>;
  accountGet(accountId: string): Promise<AccountInfo | null>;
  accountGetByIssuer(issuer: string): Promise<AccountInfo | null>;
  accountDisable(accountId: string): Promise<{ ok: boolean; accountId: string }>;
  accountAddKey(accountId: string, kid: string, publicJwk: object): Promise<{ ok: boolean; accountId: string; kid: string }>;
  accountGetKeys(accountId: string): Promise<Array<{ kid: string; publicJwk: any }>>;
  accountAddJwksUrl(accountId: string, jwksUrl: string): Promise<{ ok: boolean; accountId: string; jwksUrl: string }>;
  accountGetJwksUrl(accountId: string): Promise<any>;
  /** Remove all stored keys and JWKS URL for an account (auth-material reset). */
  accountClearAuth(accountId: string): Promise<{ ok: boolean; accountId: string }>;
  auditLogQuery(accountId: string): Promise<any[]>;
  auditLog(actor: string | null, accountId: string | null, action: string, outcome: string, metadata?: Record<string, unknown>): Promise<void>;
}

// ---------- Ports Bundle ----------

export interface Ports extends DataPort, CachePort, BlobPort, QueuePort, SearchPort, AccountPort {
  close?(): Promise<void>;
}
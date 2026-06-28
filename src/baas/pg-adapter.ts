import type { Ports } from "../ports/types.js";
import type { PgAppDataPort } from "./appdata-pg.js";

/**
 * Adapter that routes `appData*` calls to an external Postgres-backed
 * <code>PgAppDataPort</code> while delegating every other Port method to a
 * wrapped base <code>Ports</code> instance (typically PGLite).
 *
 * Replaces the <code>new Proxy(base, {...})</code> delegation used in
 * <code>app.ts</code>. The Proxy was opaque and error-prone: a missing or
 * mistyped method would silently fall through to the base instance rather
 * than throw at the call site. An explicit adapter class gives the compiler
 * a hard contract — every <code>Ports</code> method must be forwarded or
 * overridden, and a missing implementation fails at build time.
 *
 * All methods bind to the correct <code>this</code> so they can safely
 * replace the Proxy behavior.
 */
export class PgAppDataAdapter implements Ports {
  constructor(
    private readonly base: Ports,
    private readonly appData: PgAppDataPort,
  ) {}

  async close(): Promise<void> {
    if (this.base.close) await this.base.close();
  }

  // ---------- AppData (routed to PgAppDataPort) ----------

  async appDataCreate(
    accountId: string | undefined,
    userId: string,
    collection: string,
    document: import("../mongo.js").Doc,
  ): Promise<{ ok: boolean; id: string }> {
    return this.appData.appDataCreate(accountId, userId, collection, document);
  }

  async appDataGet(
    accountId: string | undefined,
    userId: string,
    collection: string,
    id: string,
  ): Promise<{ document: import("../mongo.js").Doc | null; found: boolean }> {
    return this.appData.appDataGet(accountId, userId, collection, id);
  }

  async appDataFind(
    accountId: string | undefined,
    userId: string,
    collection: string,
    options?: { filter?: import("../mongo.js").Doc; limit?: number; skip?: number },
  ): Promise<{ documents: import("../mongo.js").Doc[]; total: number }> {
    return this.appData.appDataFind(accountId, userId, collection, options);
  }

  async appDataUpdate(
    accountId: string | undefined,
    userId: string,
    collection: string,
    id: string,
    patch: import("../mongo.js").Doc,
  ): Promise<{ ok: boolean; id: string; matchedCount: number }> {
    return this.appData.appDataUpdate(accountId, userId, collection, id, patch);
  }

  async appDataDelete(
    accountId: string | undefined,
    userId: string,
    collection: string,
    id: string,
  ): Promise<{ deleted: boolean }> {
    return this.appData.appDataDelete(accountId, userId, collection, id);
  }

  async appDataCount(
    accountId: string | undefined,
    userId: string,
    collection: string,
    filter?: import("../mongo.js").Doc,
  ): Promise<{ count: number }> {
    return this.appData.appDataCount(accountId, userId, collection, filter);
  }

  // ---------- Data ----------

  async dataCreate(accountId: string | undefined, collection: string, document: import("../mongo.js").Doc): Promise<{ ok: boolean; id: string }> {
    return this.base.dataCreate(accountId, collection, document);
  }
  async dataGet(accountId: string | undefined, collection: string, id: string): Promise<{ document: import("../mongo.js").Doc | null; found: boolean }> {
    return this.base.dataGet(accountId, collection, id);
  }
  async dataReplace(accountId: string | undefined, collection: string, id: string, document: import("../mongo.js").Doc): Promise<{ ok: boolean; id: string; matchedCount: number; modifiedCount: number }> {
    return this.base.dataReplace(accountId, collection, id, document);
  }
  async dataUpdate(accountId: string | undefined, collection: string, id: string, update: import("../mongo.js").Doc): Promise<{ ok: boolean; id: string; matchedCount: number; modifiedCount: number }> {
    return this.base.dataUpdate(accountId, collection, id, update);
  }
  async dataDelete(accountId: string | undefined, collection: string, id: string): Promise<{ deleted: boolean; deletedCount: number }> {
    return this.base.dataDelete(accountId, collection, id);
  }
  async dataFind(accountId: string | undefined, collection: string, options?: { filter?: import("../mongo.js").Doc; sort?: Record<string, 1 | -1>; limit?: number; skip?: number; cursor?: string; projection?: Record<string, 0 | 1> }): Promise<{ documents: import("../mongo.js").Doc[]; cursor?: string; total: number }> {
    return this.base.dataFind(accountId, collection, options);
  }
  async dataCount(accountId: string | undefined, collection: string, filter?: import("../mongo.js").Doc): Promise<{ count: number }> {
    return this.base.dataCount(accountId, collection, filter);
  }
  async dataBulk(accountId: string | undefined, collection: string, operations: import("../ports/types.js").BulkOperation[], ordered?: boolean): Promise<{ results: Array<{ op: string; index: number; id?: string; ok: boolean; error?: string }>; insertedCount: number; modifiedCount: number; deletedCount: number; errorCount: number }> {
    return this.base.dataBulk(accountId, collection, operations, ordered);
  }
  async dataCreateIndex(accountId: string | undefined, collection: string, spec: { name: string; fields: Record<string, 1 | -1>; unique?: boolean; sparse?: boolean }): Promise<{ ok: boolean; name: string }> {
    return this.base.dataCreateIndex(accountId, collection, spec);
  }
  async dataListIndexes(accountId: string | undefined, collection: string): Promise<{ indexes: { name: string; fields: Record<string, 1 | -1>; unique?: boolean; sparse?: boolean }[] }> {
    return this.base.dataListIndexes(accountId, collection);
  }
  async dataDropIndex(accountId: string | undefined, collection: string, name: string): Promise<{ ok: boolean; name: string }> {
    return this.base.dataDropIndex(accountId, collection, name);
  }
  async dataListCollections(accountId: string | undefined): Promise<{ collections: Array<{ name: string; documentCount: number }> }> {
    return this.base.dataListCollections(accountId);
  }
  async dataDropCollection(accountId: string | undefined, collection: string): Promise<{ ok: boolean; collection: string }> {
    return this.base.dataDropCollection(accountId, collection);
  }
  async dataHealth(): Promise<{ ok: boolean; latencyMs: number }> {
    return this.base.dataHealth();
  }

  // ---------- Cache ----------

  async cacheSet(accountId: string | undefined, key: string, value: unknown, ttl?: number): Promise<{ ok: boolean; key: string; ttl: number | null }> {
    return this.base.cacheSet(accountId, key, value, ttl);
  }
  async cacheGet(accountId: string | undefined, key: string): Promise<{ value: unknown; found: boolean }> {
    return this.base.cacheGet(accountId, key);
  }
  async cacheDelete(accountId: string | undefined, key: string): Promise<{ deleted: boolean }> {
    return this.base.cacheDelete(accountId, key);
  }
  async cacheExists(accountId: string | undefined, key: string): Promise<{ exists: boolean }> {
    return this.base.cacheExists(accountId, key);
  }
  async cacheTtl(accountId: string | undefined, key: string): Promise<{ ttl: number }> {
    return this.base.cacheTtl(accountId, key);
  }
  async cacheIncr(accountId: string | undefined, key: string, by?: number): Promise<{ value: number }> {
    return this.base.cacheIncr(accountId, key, by);
  }
  async cacheDecr(accountId: string | undefined, key: string, by?: number): Promise<{ value: number }> {
    return this.base.cacheDecr(accountId, key, by);
  }

  // ---------- Blob ----------

  async blobPutText(accountId: string | undefined, key: string, text: string, contentType?: string, metadata?: Record<string, string>): Promise<{ ok: boolean; key: string; size: number; etag: string }> {
    return this.base.blobPutText(accountId, key, text, contentType, metadata);
  }
  async blobPutBase64(accountId: string | undefined, key: string, contentBase64: string, contentType?: string, metadata?: Record<string, string>): Promise<{ ok: boolean; key: string; size: number; etag: string }> {
    return this.base.blobPutBase64(accountId, key, contentBase64, contentType, metadata);
  }
  async blobGetText(accountId: string | undefined, key: string): Promise<{ text: string; contentType: string }> {
    return this.base.blobGetText(accountId, key);
  }
  async blobGetBase64(accountId: string | undefined, key: string): Promise<{ contentBase64: string; contentType: string }> {
    return this.base.blobGetBase64(accountId, key);
  }
  async blobDelete(accountId: string | undefined, key: string): Promise<{ deleted: boolean }> {
    return this.base.blobDelete(accountId, key);
  }
  async blobMeta(accountId: string | undefined, key: string): Promise<{ key: string; size: number; contentType: string; etag: string; lastModified: string; cacheControl?: string; metadata?: Record<string, string> }> {
    return this.base.blobMeta(accountId, key);
  }
  async blobList(accountId: string | undefined, options?: { prefix?: string; limit?: number; cursor?: string; includeMetadata?: boolean }): Promise<{ files: Array<{ key: string; size: number; contentType?: string; lastModified?: string }>; cursor?: string; total: number }> {
    return this.base.blobList(accountId, options);
  }
  async blobCopy(accountId: string | undefined, sourceKey: string, destinationKey: string, metadata?: Record<string, string>): Promise<{ key: string; size: number; etag: string }> {
    return this.base.blobCopy(accountId, sourceKey, destinationKey, metadata);
  }
  async blobSign(accountId: string | undefined, key: string, action: "get" | "put", options?: { expiresIn?: number }): Promise<{ url: string; expiresAt: string; method: "GET" | "PUT" }> {
    return this.base.blobSign(accountId, key, action, options);
  }

  // ---------- Queue ----------

  async queueCreateTopic(accountId: string | undefined, topic: string, partitions?: number, replicationFactor?: number, config?: any): Promise<{ ok: boolean; topic: string }> {
    return this.base.queueCreateTopic(accountId, topic, partitions, replicationFactor, config);
  }
  async queueListTopics(accountId: string | undefined, prefix?: string): Promise<{ topics: Array<any> }> {
    return this.base.queueListTopics(accountId, prefix);
  }
  async queueDeleteTopic(accountId: string | undefined, topic: string): Promise<{ deleted: boolean; topic: string }> {
    return this.base.queueDeleteTopic(accountId, topic);
  }
  async queuePublish(accountId: string | undefined, topic: string, msg: { key?: string; value: unknown; headers?: Record<string, string>; partition?: number }): Promise<{ ok: boolean; topic: string; partition: number; offset: number; timestamp: number }> {
    return this.base.queuePublish(accountId, topic, msg);
  }
  async queuePublishBatch(accountId: string | undefined, topic: string, messages: Array<any>): Promise<{ ok: boolean; topic: string; results: any[] }> {
    return this.base.queuePublishBatch(accountId, topic, messages);
  }
  async queueSubscribe(accountId: string | undefined, topic: string, groupId?: string, autoCommit?: boolean, autoOffsetReset?: "earliest" | "latest"): Promise<{ ok: boolean; subscriptionId: string; topic: string; groupId: string }> {
    return this.base.queueSubscribe(accountId, topic, groupId, autoCommit, autoOffsetReset);
  }
  async queuePoll(accountId: string | undefined, topic: string, subscriptionId: string, limit?: number): Promise<{ ok: boolean; topic: string; messages: any[]; hasMore: boolean }> {
    return this.base.queuePoll(accountId, topic, subscriptionId, limit);
  }
  async queueAck(accountId: string | undefined, topic: string, subscriptionId: string, partition: number, offset: number): Promise<{ ok: boolean; topic: string; subscriptionId: string; partition: number; offset: number }> {
    return this.base.queueAck(accountId, topic, subscriptionId, partition, offset);
  }
  async queueNack(accountId: string | undefined, topic: string, subscriptionId: string, partition: number, offset: number, reason?: string): Promise<{ ok: boolean; topic: string; subscriptionId: string; partition: number; offset: number; reason?: string }> {
    return this.base.queueNack(accountId, topic, subscriptionId, partition, offset, reason);
  }
  async queueSeek(accountId: string | undefined, topic: string, subscriptionId: string, partition: number, offset: number | "earliest" | "latest"): Promise<{ ok: boolean; topic: string; subscriptionId: string; partition: number; offset: number }> {
    return this.base.queueSeek(accountId, topic, subscriptionId, partition, offset);
  }

  // ---------- Search ----------

  async searchCreateIndex(accountId: string | undefined, index: string, mapping?: any, settings?: any): Promise<{ ok: boolean; index: string; acknowledged: boolean }> {
    return this.base.searchCreateIndex(accountId, index, mapping, settings);
  }
  async searchDeleteIndex(accountId: string | undefined, index: string): Promise<{ deleted: boolean; index: string }> {
    return this.base.searchDeleteIndex(accountId, index);
  }
  async searchHealth(accountId: string | undefined, index: string): Promise<{ status: string; index: string; shardCount: number; documentCount: number; storeSizeBytes: number }> {
    return this.base.searchHealth(accountId, index);
  }
  async searchIndexDoc(accountId: string | undefined, index: string, document: import("../mongo.js").Doc, id?: string, refresh?: boolean): Promise<{ ok: boolean; id: string; index: string; result: string; version: number }> {
    return this.base.searchIndexDoc(accountId, index, document, id, refresh);
  }
  async searchGetDoc(accountId: string | undefined, index: string, id: string): Promise<{ found: boolean; id: string; index: string; document: import("../mongo.js").Doc | null; version: number }> {
    return this.base.searchGetDoc(accountId, index, id);
  }
  async searchDeleteDoc(accountId: string | undefined, index: string, id: string): Promise<{ deleted: boolean; id: string; index: string }> {
    return this.base.searchDeleteDoc(accountId, index, id);
  }
  async searchBulk(accountId: string | undefined, index: string, operations: Array<any>, refresh?: boolean): Promise<{ ok: boolean; index: string; took: number; results: any[]; errors: number }> {
    return this.base.searchBulk(accountId, index, operations, refresh);
  }
  async searchQuery(accountId: string | undefined, index: string, body: any): Promise<{ ok: boolean; index: string; took: number; total: number; maxScore: number | null; hits: any[] }> {
    return this.base.searchQuery(accountId, index, body);
  }
  async searchCount(accountId: string | undefined, index: string): Promise<{ ok: boolean; index: string; count: number }> {
    return this.base.searchCount(accountId, index);
  }

  // ---------- Account ----------

  async accountCreate(accountId: string, name: string, issuer: string, audience: string, scopes: string[]): Promise<{ ok: boolean; accountId: string; status: string; scopes: string[] }> {
    return this.base.accountCreate(accountId, name, issuer, audience, scopes);
  }
  async accountGet(accountId: string): Promise<{ accountId: string; name: string; issuer: string; audience: string; status: string; scopes: string[] } | null> {
    return this.base.accountGet(accountId);
  }
  async accountGetByIssuer(issuer: string): Promise<{ accountId: string; name: string; issuer: string; audience: string; status: string; scopes: string[] } | null> {
    return this.base.accountGetByIssuer(issuer);
  }
  async accountDisable(accountId: string): Promise<{ ok: boolean; accountId: string }> {
    return this.base.accountDisable(accountId);
  }
  async accountAddKey(accountId: string, kid: string, publicJwk: object): Promise<{ ok: boolean; accountId: string; kid: string }> {
    return this.base.accountAddKey(accountId, kid, publicJwk);
  }
  async accountGetKeys(accountId: string): Promise<Array<{ kid: string; publicJwk: any }>> {
    return this.base.accountGetKeys(accountId);
  }
  async accountAddJwksUrl(accountId: string, jwksUrl: string): Promise<{ ok: boolean; accountId: string; jwksUrl: string }> {
    return this.base.accountAddJwksUrl(accountId, jwksUrl);
  }
  async accountGetJwksUrl(accountId: string): Promise<any> {
    return this.base.accountGetJwksUrl(accountId);
  }
  async accountClearAuth(accountId: string): Promise<{ ok: boolean; accountId: string }> {
    return this.base.accountClearAuth(accountId);
  }
  async auditLogQuery(accountId: string): Promise<any[]> {
    return this.base.auditLogQuery(accountId);
  }
  async auditLog(actor: string | null, accountId: string | null, action: string, outcome: string, metadata?: Record<string, unknown>): Promise<void> {
    return this.base.auditLog(actor, accountId, action, outcome, metadata);
  }

  // ---------- Auth ----------

  async authCreateUser(accountId: string | undefined, input: { email?: string | null; username?: string | null; phone?: string | null; attributes?: Record<string, unknown> }): Promise<{ ok: boolean; userId: string }> {
    return this.base.authCreateUser(accountId, input);
  }
  async authGetUser(accountId: string | undefined, userId: string): Promise<{ user: { userId: string; email: string | null; username: string | null; phone: string | null; attributes: Record<string, unknown>; status: string; createdAt: string; updatedAt: string } | null; found: boolean }> {
    return this.base.authGetUser(accountId, userId);
  }
  async authFindUsers(accountId: string | undefined, query: { email?: string; username?: string }): Promise<{ users: Array<{ userId: string; email: string | null; username: string | null; phone: string | null; attributes: Record<string, unknown>; status: string; createdAt: string; updatedAt: string }> }> {
    return this.base.authFindUsers(accountId, query);
  }
  async authUpdateUser(accountId: string | undefined, userId: string, patch: { email?: string | null; username?: string | null; phone?: string | null; attributes?: Record<string, unknown>; status?: string }): Promise<{ ok: boolean; userId: string; matchedCount: number }> {
    return this.base.authUpdateUser(accountId, userId, patch);
  }
  async authDeleteUser(accountId: string | undefined, userId: string): Promise<{ deleted: boolean }> {
    return this.base.authDeleteUser(accountId, userId);
  }
  async authSetPassword(accountId: string | undefined, userId: string, password: string): Promise<{ ok: boolean; userId: string }> {
    return this.base.authSetPassword(accountId, userId, password);
  }
  async authVerifyPassword(accountId: string | undefined, userId: string, password: string): Promise<{ valid: boolean }> {
    return this.base.authVerifyPassword(accountId, userId, password);
  }
  async authCreateSession(accountId: string | undefined, userId: string, options?: { ttlSeconds?: number; metadata?: Record<string, unknown> }): Promise<{ token: string; userId: string; expiresAt: string }> {
    return this.base.authCreateSession(accountId, userId, options);
  }
  async authVerifySession(accountId: string | undefined, token: string): Promise<{ valid: boolean; userId: string | null; expiresAt: string | null }> {
    return this.base.authVerifySession(accountId, token);
  }
  async authRevokeSession(accountId: string | undefined, token: string): Promise<{ revoked: boolean }> {
    return this.base.authRevokeSession(accountId, token);
  }
  async authListSessions(accountId: string | undefined, userId: string): Promise<{ sessions: Array<{ userId: string; expiresAt: string; createdAt: string; revoked: boolean }> }> {
    return this.base.authListSessions(accountId, userId);
  }
  async authCreateCode(accountId: string | undefined, input: { channel: "email" | "sms"; target: string; userId?: string; ttlSeconds?: number; maxAttempts?: number }): Promise<{ code: string; codeId: string; expiresAt: string }> {
    return this.base.authCreateCode(accountId, input);
  }
  async authVerifyCode(accountId: string | undefined, query: { channel: "email" | "sms"; target: string; code: string }): Promise<{ valid: boolean; userId: string | null }> {
    return this.base.authVerifyCode(accountId, query);
  }
  async authHealth(accountId: string): Promise<{ ok: boolean; latencyMs: number }> {
    return this.base.authHealth(accountId);
  }

  // ---------- App Function ----------

  async appCreateFunction(accountId: string | undefined, name: string, body: string, isPublic: boolean): Promise<{ ok: boolean; name: string; version: number }> {
    return this.base.appCreateFunction(accountId, name, body, isPublic);
  }
  async appGetFunction(accountId: string | undefined, name: string): Promise<{ fn: { name: string; body: string; public: boolean; version: number; createdAt: string; updatedAt: string } | null; found: boolean }> {
    return this.base.appGetFunction(accountId, name);
  }
  async appListFunctions(accountId: string | undefined): Promise<{ functions: Array<{ name: string; public: boolean; version: number; updatedAt: string }> }> {
    return this.base.appListFunctions(accountId);
  }
  async appDeleteFunction(accountId: string | undefined, name: string): Promise<{ deleted: boolean }> {
    return this.base.appDeleteFunction(accountId, name);
  }
}

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import * as z from "zod/v4";
import type { Config } from "./config.js";
import { toToolError, PortError } from "./errors.js";
import { logger, startTimer, recordToolCall } from "./logger.js";
import type { PgliteBackend } from "./pglite-backend.js";
import { hasScope, type AuthContext } from "./auth.js";

const AnyObj = z.record(z.string(), z.any());
const JsonValue = z.any();

type BackendGetter = () => Promise<PgliteBackend>;

function jsonResult(value: unknown) {
  return { content: [{ type: "text" as const, text: JSON.stringify(value, null, 2) }] };
}

function assertWrite(config: Config) {
  if (config.readOnly) throw new PortError("READ_ONLY", "MCP server is in read-only mode", 403);
}

function assertDangerous(config: Config, confirm?: boolean) {
  assertWrite(config);
  if (!confirm) throw new PortError("CONFIRM_REQUIRED", "Pass confirm: true for destructive operation", 400);
  if (!config.allowDangerous) throw new PortError("DANGEROUS_DISABLED", "Set HYPER_MCP_ALLOW_DANGEROUS=true to enable destructive operation", 403);
}

function checkScope(requiredScope: string, authRequired: boolean) {
  if (!authRequired) return;
  // Auth context is stored on a module-level variable set per-request
  // For MVP with stateless transport, we check via a closure
  // The actual scope check happens in the tool wrapper
}

export function createServer(config: Config, getBackend: BackendGetter) {
  const server = new McpServer({ name: "hyper-mcp", version: "0.1.0" }, { capabilities: { logging: {} } });

  server.registerResource("ports", "scoutos://ports", { mimeType: "application/json" }, async () => ({
    contents: [{ uri: "scoutos://ports", text: JSON.stringify({ backend: "pglite", persistentDir: config.pgDir, ports: ["data", "cache", "blob", "queue", "search"], readOnly: config.readOnly, authRequired: config.authRequired }, null, 2) }]
  }));

  function tool(name: string, description: string, inputSchema: any, requiredScope: string, handler: (args: any, backend: PgliteBackend, accountId: string | undefined) => Promise<unknown>, readOnly = false) {
    server.registerTool(name, {
      description,
      inputSchema,
      annotations: { readOnlyHint: readOnly, destructiveHint: !readOnly }
    }, async (args: any, extra: any) => {
      const timer = startTimer("tool.call", { tool: name, scope: requiredScope });
      try {
        const backend = await getBackend();

        let accountId: string | undefined;
        // Scope enforcement when auth is required
        if (config.authRequired && config.admin) {
          const authCtx = (extra as any)?.sessionInfo?.__auth as AuthContext | undefined
            ?? ((extra as any)?._meta as any)?.__auth as AuthContext | undefined
            ?? ((extra as any)?.params?.__auth) as AuthContext | undefined;
          if (!authCtx) {
            throw new PortError("AUTH_REQUIRED", "Authentication required", 401);
          }
          if (!hasScope(authCtx.scopes, requiredScope)) {
            throw new PortError("FORBIDDEN", `Missing required scope: ${requiredScope}`, 403);
          }
          accountId = authCtx.accountId;
        }

        const result = await handler(args, backend, accountId);
        timer.end({ accountId, success: true });
        recordToolCall(name, true);
        return jsonResult(result);
      }
      catch (e) {
        const err = e as Error;
        timer.end({ accountId: undefined, success: false });
        recordToolCall(name, false);
        if (err instanceof PortError) {
          logger.warn("tool error", { tool: name, code: err.code, status: err.status, message: err.message });
        } else {
          logger.error("tool unexpected error", { tool: name, error: err.message, stack: err.stack });
        }
        return toToolError(e);
      }
    });
  }

  // Data
  tool("data_create", "Create a JSON document in a collection", { collection: z.string(), document: AnyObj }, "data:write", async (a, b, accountId) => { assertWrite(config); return b.dataCreate(accountId, a.collection, a.document); });
  tool("data_get", "Get a document by collection and id", { collection: z.string(), id: z.string() }, "data:read", async (a, b, accountId) => b.dataGet(accountId, a.collection, a.id), true);
  tool("data_replace", "Replace a document", { collection: z.string(), id: z.string(), document: AnyObj }, "data:write", async (a, b, accountId) => { assertWrite(config); return b.dataReplace(accountId, a.collection, a.id, a.document); });
  tool("data_update", "Mongo-style partial update ($set, $unset, $inc, $push, $pull)", { collection: z.string(), id: z.string(), update: AnyObj }, "data:write", async (a, b, accountId) => { assertWrite(config); return b.dataUpdate(accountId, a.collection, a.id, a.update); });
  tool("data_delete", "Delete a document", { collection: z.string(), id: z.string() }, "data:write", async (a, b, accountId) => { assertWrite(config); return b.dataDelete(accountId, a.collection, a.id); });
  tool("data_find", "Find documents with Mongo-style filter/sort/pagination (MVP filters in-process)", { collection: z.string(), filter: AnyObj.optional(), sort: z.record(z.string(), z.union([z.literal(1), z.literal(-1)])).optional(), limit: z.number().int().optional(), skip: z.number().int().optional(), cursor: z.string().optional(), projection: AnyObj.optional() }, "data:read", async (a, b, accountId) => b.dataFind(accountId, a.collection, a), true);
  tool("data_count", "Count documents matching a filter", { collection: z.string(), filter: AnyObj.optional() }, "data:read", async (a, b, accountId) => b.dataCount(accountId, a.collection, a.filter), true);
  tool("data_bulk", "Run up to 1000 data operations", { collection: z.string(), operations: z.array(AnyObj), ordered: z.boolean().optional() }, "data:write", async (a, b, accountId) => { assertWrite(config); return b.dataBulk(accountId, a.collection, a.operations, a.ordered); });
  tool("data_create_index", "Record an index spec for compatibility/discovery", { collection: z.string(), spec: AnyObj }, "data:write", async (a, b, accountId) => { assertWrite(config); return b.dataCreateIndex(accountId, a.collection, a.spec); });
  tool("data_list_indexes", "List recorded index specs", { collection: z.string() }, "data:read", async (a, b, accountId) => b.dataListIndexes(accountId, a.collection), true);
  tool("data_drop_index", "Drop a recorded index spec", { collection: z.string(), name: z.string(), confirm: z.boolean().optional() }, "data:dangerous", async (a, b, accountId) => { assertDangerous(config, a.confirm); return b.dataDropIndex(accountId, a.collection, a.name); });
  tool("data_list_collections", "List data collections", {}, "data:read", async (_a, b, accountId) => b.dataListCollections(accountId), true);
  tool("data_drop_collection", "Drop a collection and all its documents", { collection: z.string(), confirm: z.boolean().optional() }, "data:dangerous", async (a, b, accountId) => { assertDangerous(config, a.confirm); return b.dataDropCollection(accountId, a.collection); });
  tool("data_health", "Check data backend health", {}, "data:read", async (_a, b, accountId) => b.dataHealth(), true);

  // Cache
  tool("cache_set", "Set JSON cache value with optional TTL seconds", { key: z.string(), value: JsonValue, ttl: z.number().optional() }, "cache:write", async (a, b, accountId) => { assertWrite(config); return b.cacheSet(accountId, a.key, a.value, a.ttl); });
  tool("cache_get", "Get cache value", { key: z.string() }, "cache:read", async (a, b, accountId) => b.cacheGet(accountId, a.key), true);
  tool("cache_delete", "Delete cache key", { key: z.string() }, "cache:write", async (a, b, accountId) => { assertWrite(config); return b.cacheDelete(accountId, a.key); });
  tool("cache_exists", "Check cache key existence", { key: z.string() }, "cache:read", async (a, b, accountId) => b.cacheExists(accountId, a.key), true);
  tool("cache_ttl", "Get cache TTL (-1 no TTL, -2 missing)", { key: z.string() }, "cache:read", async (a, b, accountId) => b.cacheTtl(accountId, a.key), true);
  tool("cache_incr", "Increment numeric cache value", { key: z.string(), by: z.number().optional() }, "cache:write", async (a, b, accountId) => { assertWrite(config); return b.cacheIncr(accountId, a.key, a.by); });
  tool("cache_decr", "Decrement numeric cache value", { key: z.string(), by: z.number().optional() }, "cache:write", async (a, b, accountId) => { assertWrite(config); return b.cacheDecr(accountId, a.key, a.by); });

  // Blob
  tool("blob_put_text", "Store UTF-8 text blob", { key: z.string(), text: z.string(), contentType: z.string().optional(), metadata: z.record(z.string(), z.string()).optional() }, "blob:write", async (a, b, accountId) => { assertWrite(config); return b.blobPutText(accountId, a.key, a.text, a.contentType, a.metadata); });
  tool("blob_put_base64", "Store base64 blob", { key: z.string(), contentBase64: z.string(), contentType: z.string().optional(), metadata: z.record(z.string(), z.string()).optional() }, "blob:write", async (a, b, accountId) => { assertWrite(config); return b.blobPutBase64(accountId, a.key, a.contentBase64, a.contentType, a.metadata); });
  tool("blob_get_text", "Get blob decoded as UTF-8 text", { key: z.string() }, "blob:read", async (a, b, accountId) => b.blobGetText(accountId, a.key), true);
  tool("blob_get_base64", "Get blob as base64", { key: z.string() }, "blob:read", async (a, b, accountId) => b.blobGetBase64(accountId, a.key), true);
  tool("blob_delete", "Delete blob", { key: z.string() }, "blob:write", async (a, b, accountId) => { assertWrite(config); return b.blobDelete(accountId, a.key); });
  tool("blob_meta", "Get blob metadata", { key: z.string() }, "blob:read", async (a, b, accountId) => b.blobMeta(accountId, a.key), true);
  tool("blob_list", "List blobs by prefix", { prefix: z.string().optional(), limit: z.number().int().optional(), cursor: z.string().optional() }, "blob:read", async (a, b, accountId) => b.blobList(accountId, a), true);
  tool("blob_copy", "Copy blob", { sourceKey: z.string(), destinationKey: z.string(), metadata: z.record(z.string(), z.string()).optional() }, "blob:write", async (a, b, accountId) => { assertWrite(config); return b.blobCopy(accountId, a.sourceKey, a.destinationKey, a.metadata); });
  tool("blob_sign", "Return local pglite:// pseudo signed URL for MVP", { key: z.string(), action: z.enum(["get", "put"]), expiresIn: z.number().optional() }, "blob:read", async (a, b, accountId) => b.blobSign(accountId, a.key, a.action, { expiresIn: a.expiresIn }), true);

  // Queue
  tool("queue_create_topic", "Create queue topic", { topic: z.string(), partitions: z.number().int().optional(), replicationFactor: z.number().int().optional(), config: AnyObj.optional() }, "queue:write", async (a, b, accountId) => { assertWrite(config); return b.queueCreateTopic(accountId, a.topic, a.partitions, a.replicationFactor, a.config); });
  tool("queue_list_topics", "List queue topics", { prefix: z.string().optional() }, "queue:read", async (a, b, accountId) => b.queueListTopics(accountId, a.prefix), true);
  tool("queue_delete_topic", "Delete queue topic and messages", { topic: z.string(), confirm: z.boolean().optional() }, "queue:dangerous", async (a, b, accountId) => { assertDangerous(config, a.confirm); return b.queueDeleteTopic(accountId, a.topic); });
  tool("queue_publish", "Publish one message", { topic: z.string(), key: z.string().optional(), value: JsonValue, headers: z.record(z.string(), z.string()).optional(), partition: z.number().int().optional() }, "queue:write", async (a, b, accountId) => { assertWrite(config); return b.queuePublish(accountId, a.topic, a); });
  tool("queue_publish_batch", "Publish up to 1000 messages", { topic: z.string(), messages: z.array(AnyObj) }, "queue:write", async (a, b, accountId) => { assertWrite(config); return b.queuePublishBatch(accountId, a.topic, a.messages); });
  tool("queue_subscribe", "Create subscription", { topic: z.string(), groupId: z.string().optional(), autoCommit: z.boolean().optional(), autoOffsetReset: z.enum(["earliest", "latest"]).optional() }, "queue:write", async (a, b, accountId) => { assertWrite(config); return b.queueSubscribe(accountId, a.topic, a.groupId, a.autoCommit, a.autoOffsetReset); });
  tool("queue_poll", "Poll messages for subscription", { topic: z.string(), subscriptionId: z.string(), limit: z.number().int().optional() }, "queue:read", async (a, b, accountId) => b.queuePoll(accountId, a.topic, a.subscriptionId, a.limit), true);
  tool("queue_ack", "Acknowledge message offset", { topic: z.string(), subscriptionId: z.string(), partition: z.number().int(), offset: z.number().int() }, "queue:write", async (a, b, accountId) => { assertWrite(config); return b.queueAck(accountId, a.topic, a.subscriptionId, a.partition, a.offset); });
  tool("queue_nack", "Negative acknowledge message offset", { topic: z.string(), subscriptionId: z.string(), partition: z.number().int(), offset: z.number().int(), reason: z.string().optional() }, "queue:write", async (a, b, accountId) => { assertWrite(config); return b.queueNack(accountId, a.topic, a.subscriptionId, a.partition, a.offset, a.reason); });
  tool("queue_seek", "Seek subscription offset", { topic: z.string(), subscriptionId: z.string(), partition: z.number().int(), offset: z.union([z.number().int(), z.enum(["earliest", "latest"])]) }, "queue:write", async (a, b, accountId) => { assertWrite(config); return b.queueSeek(accountId, a.topic, a.subscriptionId, a.partition, a.offset); });

  // Search
  tool("search_create_index", "Create search index", { index: z.string(), mapping: AnyObj.optional(), settings: AnyObj.optional() }, "search:write", async (a, b, accountId) => { assertWrite(config); return b.searchCreateIndex(accountId, a.index, a.mapping, a.settings); });
  tool("search_delete_index", "Delete search index and docs", { index: z.string(), confirm: z.boolean().optional() }, "search:dangerous", async (a, b, accountId) => { assertDangerous(config, a.confirm); return b.searchDeleteIndex(accountId, a.index); });
  tool("search_health", "Search index health", { index: z.string() }, "search:read", async (a, b, accountId) => b.searchHealth(accountId, a.index), true);
  tool("search_index_doc", "Index or update search document", { index: z.string(), id: z.string().optional(), document: AnyObj, refresh: z.boolean().optional() }, "search:write", async (a, b, accountId) => { assertWrite(config); return b.searchIndexDoc(accountId, a.index, a.document, a.id, a.refresh); });
  tool("search_get_doc", "Get search document", { index: z.string(), id: z.string() }, "search:read", async (a, b, accountId) => b.searchGetDoc(accountId, a.index, a.id), true);
  tool("search_delete_doc", "Delete search document", { index: z.string(), id: z.string() }, "search:write", async (a, b, accountId) => { assertWrite(config); return b.searchDeleteDoc(accountId, a.index, a.id); });
  tool("search_bulk", "Run up to 1000 search operations", { index: z.string(), operations: z.array(AnyObj), refresh: z.boolean().optional() }, "search:write", async (a, b, accountId) => { assertWrite(config); return b.searchBulk(accountId, a.index, a.operations, a.refresh); });
  tool("search_query", "Query search index. Supports q string, match_all, match, and term MVP DSL", { index: z.string(), query: z.any().optional(), q: z.string().optional(), from: z.number().int().optional(), size: z.number().int().optional() }, "search:read", async (a, b, accountId) => b.searchQuery(accountId, a.index, a), true);
  tool("search_simple_query", "Simple full text contains search", { index: z.string(), q: z.string(), size: z.number().int().optional(), from: z.number().int().optional() }, "search:read", async (a, b, accountId) => b.searchQuery(accountId, a.index, a), true);
  tool("search_count", "Count search documents", { index: z.string() }, "search:read", async (a, b, accountId) => b.searchCount(accountId, a.index), true);

  return server;
}

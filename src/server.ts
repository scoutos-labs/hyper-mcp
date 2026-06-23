import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import * as z from "zod/v4";
import type { Config } from "./config.js";
import { toToolError, PortError } from "./errors.js";
import { PgliteBackend } from "./pglite-backend.js";

const AnyObj = z.record(z.string(), z.any());
const JsonValue = z.any();

type Handler = (args: any) => Promise<unknown>;

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

function tool(server: McpServer, name: string, description: string, inputSchema: any, handler: Handler, readOnly = false) {
  server.registerTool(name, {
    description,
    inputSchema,
    annotations: { readOnlyHint: readOnly, destructiveHint: !readOnly }
  }, async (args: any) => {
    try { return jsonResult(await handler(args)); }
    catch (e) { return toToolError(e); }
  });
}

export function createServer(config: Config) {
  const backend = new PgliteBackend(config.pgDir);
  const server = new McpServer({ name: "hyper-mcp", version: "0.1.0" }, { capabilities: { logging: {} } });

  server.registerResource("ports", "scoutos://ports", { mimeType: "application/json" }, async () => ({
    contents: [{ uri: "scoutos://ports", text: JSON.stringify({ backend: "pglite", persistentDir: config.pgDir, ports: ["data", "cache", "blob", "queue", "search"], readOnly: config.readOnly }, null, 2) }]
  }));

  // Data
  tool(server, "data_create", "Create a JSON document in a collection", { collection: z.string(), document: AnyObj }, a => { assertWrite(config); return backend.dataCreate(a.collection, a.document); });
  tool(server, "data_get", "Get a document by collection and id", { collection: z.string(), id: z.string() }, a => backend.dataGet(a.collection, a.id), true);
  tool(server, "data_replace", "Replace a document", { collection: z.string(), id: z.string(), document: AnyObj }, a => { assertWrite(config); return backend.dataReplace(a.collection, a.id, a.document); });
  tool(server, "data_update", "Mongo-style partial update ($set, $unset, $inc, $push, $pull)", { collection: z.string(), id: z.string(), update: AnyObj }, a => { assertWrite(config); return backend.dataUpdate(a.collection, a.id, a.update); });
  tool(server, "data_delete", "Delete a document", { collection: z.string(), id: z.string() }, a => { assertWrite(config); return backend.dataDelete(a.collection, a.id); });
  tool(server, "data_find", "Find documents with Mongo-style filter/sort/pagination (MVP filters in-process)", { collection: z.string(), filter: AnyObj.optional(), sort: z.record(z.string(), z.union([z.literal(1), z.literal(-1)])).optional(), limit: z.number().int().optional(), skip: z.number().int().optional(), cursor: z.string().optional(), projection: AnyObj.optional() }, a => backend.dataFind(a.collection, a), true);
  tool(server, "data_count", "Count documents matching a filter", { collection: z.string(), filter: AnyObj.optional() }, a => backend.dataCount(a.collection, a.filter), true);
  tool(server, "data_bulk", "Run up to 1000 data operations", { collection: z.string(), operations: z.array(AnyObj), ordered: z.boolean().optional() }, a => { assertWrite(config); return backend.dataBulk(a.collection, a.operations, a.ordered); });
  tool(server, "data_create_index", "Record an index spec for compatibility/discovery", { collection: z.string(), spec: AnyObj }, a => { assertWrite(config); return backend.dataCreateIndex(a.collection, a.spec); });
  tool(server, "data_list_indexes", "List recorded index specs", { collection: z.string() }, a => backend.dataListIndexes(a.collection), true);
  tool(server, "data_drop_index", "Drop a recorded index spec", { collection: z.string(), name: z.string(), confirm: z.boolean().optional() }, a => { assertDangerous(config, a.confirm); return backend.dataDropIndex(a.collection, a.name); });
  tool(server, "data_list_collections", "List data collections", {}, () => backend.dataListCollections(), true);
  tool(server, "data_drop_collection", "Drop a collection and all its documents", { collection: z.string(), confirm: z.boolean().optional() }, a => { assertDangerous(config, a.confirm); return backend.dataDropCollection(a.collection); });
  tool(server, "data_health", "Check data backend health", {}, () => backend.dataHealth(), true);

  // Cache
  tool(server, "cache_set", "Set JSON cache value with optional TTL seconds", { key: z.string(), value: JsonValue, ttl: z.number().optional() }, a => { assertWrite(config); return backend.cacheSet(a.key, a.value, a.ttl); });
  tool(server, "cache_get", "Get cache value", { key: z.string() }, a => backend.cacheGet(a.key), true);
  tool(server, "cache_delete", "Delete cache key", { key: z.string() }, a => { assertWrite(config); return backend.cacheDelete(a.key); });
  tool(server, "cache_exists", "Check cache key existence", { key: z.string() }, a => backend.cacheExists(a.key), true);
  tool(server, "cache_ttl", "Get cache TTL (-1 no TTL, -2 missing)", { key: z.string() }, a => backend.cacheTtl(a.key), true);
  tool(server, "cache_incr", "Increment numeric cache value", { key: z.string(), by: z.number().optional() }, a => { assertWrite(config); return backend.cacheIncr(a.key, a.by); });
  tool(server, "cache_decr", "Decrement numeric cache value", { key: z.string(), by: z.number().optional() }, a => { assertWrite(config); return backend.cacheDecr(a.key, a.by); });

  // Blob
  tool(server, "blob_put_text", "Store UTF-8 text blob", { key: z.string(), text: z.string(), contentType: z.string().optional(), metadata: z.record(z.string(), z.string()).optional() }, a => { assertWrite(config); return backend.blobPutText(a.key, a.text, a.contentType, a.metadata); });
  tool(server, "blob_put_base64", "Store base64 blob", { key: z.string(), contentBase64: z.string(), contentType: z.string().optional(), metadata: z.record(z.string(), z.string()).optional() }, a => { assertWrite(config); return backend.blobPutBase64(a.key, a.contentBase64, a.contentType, a.metadata); });
  tool(server, "blob_get_text", "Get blob decoded as UTF-8 text", { key: z.string() }, a => backend.blobGetText(a.key), true);
  tool(server, "blob_get_base64", "Get blob as base64", { key: z.string() }, a => backend.blobGetBase64(a.key), true);
  tool(server, "blob_delete", "Delete blob", { key: z.string() }, a => { assertWrite(config); return backend.blobDelete(a.key); });
  tool(server, "blob_meta", "Get blob metadata", { key: z.string() }, a => backend.blobMeta(a.key), true);
  tool(server, "blob_list", "List blobs by prefix", { prefix: z.string().optional(), limit: z.number().int().optional(), cursor: z.string().optional() }, a => backend.blobList(a), true);
  tool(server, "blob_copy", "Copy blob", { sourceKey: z.string(), destinationKey: z.string(), metadata: z.record(z.string(), z.string()).optional() }, a => { assertWrite(config); return backend.blobCopy(a.sourceKey, a.destinationKey, a.metadata); });
  tool(server, "blob_sign", "Return local pglite:// pseudo signed URL for MVP", { key: z.string(), action: z.enum(["get", "put"]), expiresIn: z.number().optional() }, a => backend.blobSign(a.key, a.action, { expiresIn: a.expiresIn }), true);

  // Queue
  tool(server, "queue_create_topic", "Create queue topic", { topic: z.string(), partitions: z.number().int().optional(), replicationFactor: z.number().int().optional(), config: AnyObj.optional() }, a => { assertWrite(config); return backend.queueCreateTopic(a.topic, a.partitions, a.replicationFactor, a.config); });
  tool(server, "queue_list_topics", "List queue topics", { prefix: z.string().optional() }, a => backend.queueListTopics(a.prefix), true);
  tool(server, "queue_delete_topic", "Delete queue topic and messages", { topic: z.string(), confirm: z.boolean().optional() }, a => { assertDangerous(config, a.confirm); return backend.queueDeleteTopic(a.topic); });
  tool(server, "queue_publish", "Publish one message", { topic: z.string(), key: z.string().optional(), value: JsonValue, headers: z.record(z.string(), z.string()).optional(), partition: z.number().int().optional() }, a => { assertWrite(config); return backend.queuePublish(a.topic, a); });
  tool(server, "queue_publish_batch", "Publish up to 1000 messages", { topic: z.string(), messages: z.array(AnyObj) }, a => { assertWrite(config); return backend.queuePublishBatch(a.topic, a.messages); });
  tool(server, "queue_subscribe", "Create subscription", { topic: z.string(), groupId: z.string().optional(), autoCommit: z.boolean().optional(), autoOffsetReset: z.enum(["earliest", "latest"]).optional() }, a => { assertWrite(config); return backend.queueSubscribe(a.topic, a.groupId, a.autoCommit, a.autoOffsetReset); });
  tool(server, "queue_poll", "Poll messages for subscription", { topic: z.string(), subscriptionId: z.string(), limit: z.number().int().optional() }, a => backend.queuePoll(a.topic, a.subscriptionId, a.limit), true);
  tool(server, "queue_ack", "Acknowledge message offset", { topic: z.string(), subscriptionId: z.string(), partition: z.number().int(), offset: z.number().int() }, a => { assertWrite(config); return backend.queueAck(a.topic, a.subscriptionId, a.partition, a.offset); });
  tool(server, "queue_nack", "Negative acknowledge message offset", { topic: z.string(), subscriptionId: z.string(), partition: z.number().int(), offset: z.number().int(), reason: z.string().optional() }, a => { assertWrite(config); return backend.queueNack(a.topic, a.subscriptionId, a.partition, a.offset, a.reason); });
  tool(server, "queue_seek", "Seek subscription offset", { topic: z.string(), subscriptionId: z.string(), partition: z.number().int(), offset: z.union([z.number().int(), z.enum(["earliest", "latest"])]) }, a => { assertWrite(config); return backend.queueSeek(a.topic, a.subscriptionId, a.partition, a.offset); });

  // Search
  tool(server, "search_create_index", "Create search index", { index: z.string(), mapping: AnyObj.optional(), settings: AnyObj.optional() }, a => { assertWrite(config); return backend.searchCreateIndex(a.index, a.mapping, a.settings); });
  tool(server, "search_delete_index", "Delete search index and docs", { index: z.string(), confirm: z.boolean().optional() }, a => { assertDangerous(config, a.confirm); return backend.searchDeleteIndex(a.index); });
  tool(server, "search_health", "Search index health", { index: z.string() }, a => backend.searchHealth(a.index), true);
  tool(server, "search_index_doc", "Index or update search document", { index: z.string(), id: z.string().optional(), document: AnyObj, refresh: z.boolean().optional() }, a => { assertWrite(config); return backend.searchIndexDoc(a.index, a.document, a.id, a.refresh); });
  tool(server, "search_get_doc", "Get search document", { index: z.string(), id: z.string() }, a => backend.searchGetDoc(a.index, a.id), true);
  tool(server, "search_delete_doc", "Delete search document", { index: z.string(), id: z.string() }, a => { assertWrite(config); return backend.searchDeleteDoc(a.index, a.id); });
  tool(server, "search_bulk", "Run up to 1000 search operations", { index: z.string(), operations: z.array(AnyObj), refresh: z.boolean().optional() }, a => { assertWrite(config); return backend.searchBulk(a.index, a.operations, a.refresh); });
  tool(server, "search_query", "Query search index. Supports q string, match_all, match, and term MVP DSL", { index: z.string(), query: z.any().optional(), q: z.string().optional(), from: z.number().int().optional(), size: z.number().int().optional() }, a => backend.searchQuery(a.index, a), true);
  tool(server, "search_simple_query", "Simple full text contains search", { index: z.string(), q: z.string(), size: z.number().int().optional(), from: z.number().int().optional() }, a => backend.searchQuery(a.index, a), true);
  tool(server, "search_count", "Count search documents", { index: z.string() }, a => backend.searchCount(a.index), true);

  return server;
}

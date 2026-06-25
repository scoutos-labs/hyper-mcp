# Port Contracts

This page distinguishes **compatibility behavior** (what the port does today,
backed by persistent PGLite) from **production guarantees** (what a future
adapter — e.g. a ScoutOS remote backend — would need to provide). The MCP tool
surface and scope mapping are identical across adapters; only the storage
semantics differ.

Use this to set expectations for the current PGLite MVP and to scope a future
adapter conformance suite.

## data

**Compatibility behavior (PGLite):**

- JSON documents in named collections, tenant-scoped by `account_id`.
- `data_find` loads all documents for a collection, then filters, sorts,
  projects, and paginates in JavaScript (`src/mongo.ts`).
- `data_create_index` records an index spec as compatibility/discovery
  metadata. It does **not** create an operational SQL index, and `data_find`
  does not use it to accelerate queries.
- `data_bulk` runs up to 1000 operations.

**Not a production guarantee:**

- No query acceleration from recorded indexes.
- Large collections degrade because filtering is in-process.
- No `$lookup`, no transactions across documents, no change streams.

## cache

**Compatibility behavior (PGLite):**

- JSON key/value entries with optional TTL (seconds).
- `cache_incr` / `cache_decr` are atomic: the read-modify-write runs inside a
  serialized PGLite transaction, so concurrent increments do not lose updates.
  TTL (`expires_at`) is preserved across increments. A missing key is created
  with `value = by` and no TTL.
- `cache_ttl` returns `-1` (no TTL), `-2` (missing), or the remaining seconds.

**Not a production guarantee:**

- Counters are atomic under concurrency (single-process PGLite).
- No pub/sub, no eviction policies beyond TTL expiry.

## blob

**Compatibility behavior (PGLite):**

- Text and base64 blobs stored as base64 text inside PGLite, up to 100MB each.
- `blob_sign` returns a `pglite://` pseudo URL for MVP. It is **not** an
  externally usable signed URL — it cannot be fetched by an external client.
- `blob_list` paginates by prefix.

**Not a production guarantee:**

- Not object storage. A production adapter should back blobs with an object
  store and return real signed URLs.
- Single-disk sizing limits apply (Render disk is 1GB by default).

## queue

**Compatibility behavior (PGLite):**

- Topics, subscriptions, poll/ack/nack/seek.
- Offsets are allocated as `max(offset)+1` inside a serialized PGLite
  transaction, so concurrent publishers get unique, contiguous offsets with no
  collisions.
- Partition support is partial: polling and subscriptions track a single
  `next_offset` rather than independent offsets per `(subscription, partition)`.

**Not a production guarantee:**

- Not Kafka-grade. No consumer groups with rebalancing, no exactly-once, no
  retention policies beyond topic deletion.
- Offsets are unique and contiguous under concurrency (single-process PGLite).

## search

**Compatibility behavior (PGLite):**

- Persistent document indexes; documents stored as duplicated lowercased JSON
  text.
- `search_query` supports a small DSL (`q` string, `match_all`, `match`,
  `term`) implemented as in-process contains/match filtering. There is **no
  scoring and no real full-text index**.
- `search_count` and `search_health` report index statistics.

**Not a production guarantee:**

- No relevance scoring, no analyzers/tokenizers, no BM25, no fuzzy or
  autocomplete queries.
- A production adapter should back search with a real search engine.

## Cross-cutting

- **Tenant isolation:** every data-plane table is keyed by `account_id`. This
  is a production guarantee and is covered by `test/tenant-isolation.test.ts`.
- **Scopes:** runtime scopes come from the server-side account record, not from
  caller JWT claims. This is a production guarantee.
- **Auth material:** `/register` fully replaces auth material on re-register
  (Option A). See `auth-prd.md` "Replacement semantics".
- **Adapter boundary:** `src/ports/types.ts` is the contract; `server.ts`
  depends only on `Ports`. A future adapter must implement the full `Ports`
  surface (data + control plane) and pass the conformance suite (Step 8).
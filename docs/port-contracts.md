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

## auth port

**Compatibility behavior (what works now):**

- `auth_create_user` / `auth_update_user`: email and username are unique within
  an account via partial unique indexes; duplicate inserts/updates return
  `AUTH_DUPLICATE` (409). Different accounts may reuse the same email/username.
- `auth_set_password` / `auth_verify_password`: passwords are scrypt-hashed with
  a per-user 16-byte salt (N=16384, r=8, p=1, 32-byte key), stored in a separate
  `auth_credentials` table. Read tools never return hashes; `auth_verify_password`
  returns only `{ valid }`.
- `auth_create_session` / `auth_verify_session` / `auth_revoke_session` /
  `auth_list_sessions`: sessions are opaque 32-byte `base64url` tokens; only
  `sha256(token)` is stored. Verify checks `revoked=false` and `expires_at > now()`.
  `auth_list_sessions` returns active sessions without token hashes.
- `auth_create_code` / `auth_verify_code`: 6-digit codes stored as `sha256(code)`;
  one active code per `(account, target)` (create replaces prior); default TTL
  600s, default max attempts 5; verify consumes on success and increments
  attempts on miss; once `attempts >= max_attempts` the code is unusable.
- `auth_delete_user` cascades credentials, sessions, and codes.

**Not a production guarantee (MVP limits):**

- No rate limiting or brute-force protection beyond the per-code attempt cap;
  deployments must add their own throttling.
- No OAuth/OIDC linking, social login, magic-link email delivery, refresh
  tokens, session rotation, MFA, or passkeys (deferred).
- Session tokens are opaque, not signed JWTs; there is no offline verification.
- hyper-mcp does not send email/SMS; `auth_create_code` returns the code and the
  caller is responsible for delivery.

## app (BaaS) port + dynamic endpoint

**Compatibility behavior (what works now):**

- `app_register_function` / `app_get_function` / `app_list_functions` /
  `app_delete_function`: function store keyed by `(account_id, name)`; re-register
  bumps `version`; tenant-isolated by account.
- `POST /u/:accountId/:fn`: resolves the function by name; if not `public`,
  resolves the caller via an opaque session token (IdentityResolver prototype)
  to `(accountId, userId)`; runs the function in the prototype `node:vm` runtime
  with a scoped `ctx`; returns JSON. Unknown function → 404; authed function
  without a valid token → 401; runtime error → 500 (no stack leak in hosted mode).
- `ctx.db` is backed by `app_data(account_id, user_id, collection, id)` — every
  query is filtered by `account_id AND user_id`, so cross-user access is
  structurally impossible from a function (prototype RLS).
- `ctx.auth` proxies the auth port scoped to the route's `accountId`.
- `ctx.kv` is a per-user JSON namespace over the cache port (`kv:<userId>:<key>`).

**Not a production guarantee (MVP limits):**

- The prototype `FunctionRuntime` (`node:vm`) is **not a security barrier** —
  trusted dev code only. Untrusted/multi-tenant code requires the Daytona adapter
  (contract-only). A startup warning is logged.
- RLS is enforced in application code (the `ctx.db` wrapper), not by the database
  engine. PGLite does not enforce RLS policies (verified). The prod adapter moves
  to engine-enforced Postgres RLS.
- No `ctx.fetch`/network, no filesystem, no env, no timers, no per-function
  CPU/memory caps beyond the wall-clock `HYPER_MCP_FUNCTION_TIMEOUT_MS`.
- Async work in a function is not killed mid-flight on timeout; the endpoint
  returns but the underlying promise may still resolve.
- Functions are plain JS (no TypeScript transpilation); latest version wins (no
  aliasing/canary/rollback).

## prod adapters (OIDC, Daytona, external Postgres RLS)

The BaaS prototype adapters ship by default. Prod adapters are config-selected
behind the same contracts (see README "Prod adapters").

**OIDC IdentityResolver (`baasIdentity=oidc`):** verifies an end-user OIDC JWT
against the provider's JWKS; routes by `iss` to a configured provider bound to
an `accountId`; `sub` becomes the `userId`. No JWT stored; no user row
auto-provisioned (`sub` is a stable row key for `app_data`). Unverified `iss`
only routes; `jwtVerify` enforces signature/aud/exp.

**Daytona FunctionRuntime (`baasRuntime=daytona`):** executes functions in an
isolated Daytona sandbox. The sandbox receives a JS shim + the user handler +
a short-lived signed **cap token**; its only egress is `POST /_internal/cap/:op`
back to hyper-mcp, which re-verifies the token and enforces user-scoping
server-side. The sandbox never sees DB credentials or host access. This is a
real security barrier (unlike the `node:vm` prototype).

**Internal capability RPC (`/_internal/cap/:op`):** HS256 JWT cap token binding
`{accountId, userId, exp}`, signed with a per-process random secret. Ops:
`db_*` (require userId), `kv_*` (require userId), `auth_*` (account-only ok).
Mirrors the prototype `ctx` exactly. Rejected/expired/tampered → 401.

**PgAppDataPort (`appDataBackend=pg`):** `app_data` on external Postgres with
`ENABLE + FORCE ROW LEVEL SECURITY` + policy
`USING (user_id = current_setting('app.user_id', true)) WITH CHECK (...)`. Every
method opens a transaction and runs `SELECT set_config('app.user_id', $1, true)`
first, so the **engine** enforces scoping — not a wrapper. PGLite cannot enforce
RLS (verified), which is why the prototype uses app-level filtering and the prod
path uses external Postgres.

**Not a production guarantee (MVP limits):**
- Real Daytona e2e + real Postgres RLS tests are opt-in (gated on
  `DAYTONA_API_KEY` / `PG_TEST_URL`); mocked orchestration + unit tests run by default.
- Per-call Daytona sandbox create (no warm pool yet).
- No function network egress beyond the capability RPC.
- The full external-Postgres `Ports` adapter (all ports) is a follow-up; only
  `app_data` RLS is proven on external Postgres here.

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
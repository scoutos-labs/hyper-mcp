# Architecture Review — hyper-mcp

Date: 2026-06-24

## Executive summary

`hyper-mcp` is a TypeScript MCP server that exposes ScoutOS-style ports for `data`, `cache`, `blob`, `queue`, and `search`, backed today by persistent PGLite. The architecture is intentionally small: transport entry points build an MCP tool catalog, tools enforce safety/auth gates, and all persistence goes through a `Ports` adapter interface.

The core direction is sound. The strongest decisions are:

- MCP tool registration is transport-agnostic in `src/server.ts`.
- HTTP production concerns live in `src/http.ts`.
- Persistence is hidden behind `src/ports/types.ts` and `src/ports/factory.ts`.
- Account scopes are server-authoritative from the database, not trusted from caller JWT claims.
- Tenant isolation is consistently modeled with `account_id` in PGLite tables and covered by tests.

The main risks are not conceptual; they are boundary and scale issues typical of an MVP:

1. Auth behavior differs between HTTP and stdio/default-account flows.
2. Account issuer/key lifecycle needs stronger uniqueness and replacement semantics.
3. Several port semantics are in-process approximations, not production-grade indexed/atomic implementations.
4. Public observability, read-only behavior, and destructive/control-plane operations need explicit policy decisions.
5. PGLite-on-disk is a good single-instance backend, but horizontal scaling and large blob/search workloads need a different adapter or object/index service.

## System purpose

The service gives agents an MCP-compatible interface over durable service primitives:

- **Data**: JSON documents, Mongo-style find/update/project compatibility.
- **Cache**: JSON key/value entries with optional TTL and counters.
- **Blob**: text/base64 object storage with metadata.
- **Queue**: topics, subscriptions, polling, ack/nack/seek.
- **Search**: document indexes with simple full-text/query compatibility.
- **Accounts**: admin-created agent accounts, JWT keys/JWKS, scopes, and audit logs.

It supports two runtime modes:

- **HTTP**: Render-ready service exposing `/`, `/health`, `/metrics`, `/register`, `/unregister`, and `/mcp`.
- **stdio**: local MCP server transport for local agents.

## High-level architecture

```text
                  ┌──────────────────────────┐
                  │        Clients           │
                  │ MCP HTTP / stdio agents  │
                  └────────────┬─────────────┘
                               │
             ┌─────────────────┴─────────────────┐
             │                                   │
      ┌──────▼──────┐                     ┌──────▼──────┐
      │ src/http.ts │                     │ src/index.ts│
      │ HTTP app    │                     │ stdio entry │
      └──────┬──────┘                     └──────┬──────┘
             │                                   │
             └───────────────┬───────────────────┘
                             │
                    ┌────────▼────────┐
                    │ src/server.ts   │
                    │ MCP tools       │
                    │ scope/safety    │
                    └────────┬────────┘
                             │ Ports interface
                    ┌────────▼────────┐
                    │ src/ports/*     │
                    │ adapter factory │
                    └────────┬────────┘
                             │
                  ┌──────────▼──────────┐
                  │ src/pglite-backend  │
                  │ PGLite persistence  │
                  └─────────────────────┘
```

## Module map

| Module | Responsibility | Notes |
|---|---|---|
| `src/config.ts` | Parse env config and admin trust root. | Defaults to PGLite, auth required, dangerous ops disabled. |
| `src/http.ts` | HTTP runtime, public routes, admin routes, protected `/mcp`, lazy backend lifecycle, graceful shutdown. | Creates a fresh MCP server/transport per stateless HTTP request, but reuses the cached backend. |
| `src/index.ts` | stdio runtime entry. | Uses same `createServer` and adapter factory. |
| `src/server.ts` | MCP resource/tool catalog, scope enforcement, read-only/dangerous guards, JSON tool responses. | Properly depends on `Ports`, not PGLite. |
| `src/auth.ts` | Admin JWT validation, account JWT validation, scope parsing/checks. | Runtime scopes come from account DB rows. |
| `src/auth-context.ts` | AsyncLocalStorage bridge from HTTP request auth into MCP tool handlers. | Necessary because MCP SDK tool handlers do not receive the Express request object. |
| `src/auth-routes.ts` | Admin-protected register/unregister endpoints. | Mutates account/key/JWKS/audit tables. |
| `src/ports/types.ts` | Data/cache/blob/queue/search/account adapter contract. | Flat interface, one method namespace per operation. |
| `src/ports/factory.ts` | Backend adapter selection and singleton lifecycle. | Only `pglite` is implemented; `scoutos` and `memory` are future placeholders. |
| `src/pglite-backend.ts` | Concrete implementation of every port plus account store. | Monolithic but straightforward; all tenant data keyed by `account_id`. |
| `src/mongo.ts` | Mongo-style compatibility helpers for filters, sorting, updates, projections. | Runs in JS after rows are loaded. |
| `src/logger.ts` | Structured logs, timers, volatile metrics, request logger middleware. | `/metrics` exposes in-process counters. |
| `scripts/smoke.ts` | Public endpoint and auth posture smoke checks. | Useful for local/Render sanity checks. |
| `test/*` | Adapter, auth, integration, tenant isolation tests. | Good coverage of storage behavior and tenant separation; HTTP auth path coverage should improve. |

## Runtime flows

### HTTP request flow

```text
POST /mcp
  │
  ├─ if auth required:
  │    ├─ require admin trust root to be configured
  │    ├─ extract bearer token
  │    ├─ lazy-init Ports backend
  │    ├─ find active account by JWT issuer
  │    ├─ verify JWT with registered key/JWKS and account audience
  │    └─ attach auth context to request
  │
  ├─ create request-scoped McpServer
  ├─ create stateless StreamableHTTPServerTransport
  ├─ run transport inside AsyncLocalStorage auth context
  └─ tool handler checks scope and delegates to Ports
```

This keeps HTTP concerns out of tool definitions, but makes `AsyncLocalStorage` part of the security-critical path.

### Account registration flow

```text
POST /register
  │
  ├─ require configured admin trust root
  ├─ verify admin JWT issuer/audience/key
  ├─ require accounts:admin scope in admin token
  ├─ validate accountId, issuer, audience, publicJwk OR jwksUrl, ports
  ├─ parse enabled port grants into scopes
  ├─ create/update account row
  ├─ store public key or JWKS URL
  └─ write audit log
```

`/unregister` disables an account rather than deleting tenant data.

### stdio flow

```text
src/index.ts
  ├─ load config
  ├─ create MCP server with createServer(config, createPorts)
  ├─ connect StdioServerTransport
  └─ tools delegate to the same Ports backend
```

Important caveat: stdio has no HTTP bearer-token step. Tool-level auth only runs when `authRequired && admin` is true. With default auth required but no admin trust root, HTTP `/mcp` returns `503`, while stdio tools can run as the default account if the `admin` config is absent. This inconsistency should be resolved.

## Data and tenant isolation model

Every data-plane port method takes `accountId` as its first argument. HTTP tools pass the authenticated account id. If no account id is present, PGLite maps it to the internal `default` account.

PGLite schema uses `account_id` in primary keys or filters for:

- `data_docs`
- `data_indexes`
- `cache_entries`
- `blob_objects`
- `queue_topics`
- `queue_messages`
- `queue_subscriptions`
- `search_indexes`
- `search_docs`

This is the right isolation model for a single shared database. Tenant isolation tests cover data, cache, blob, queue, and search behavior.

Account/control-plane tables are stored in the same PGLite database:

- `accounts`
- `account_keys`
- `account_jwks`
- `account_audit_log`

That keeps deployment simple, but it couples auth availability and tenant data availability to the same backend.

## Backend adapter design

Current shape:

```text
server.ts ──depends on──> Ports interface ──implemented by──> PgliteBackend
```

This is a good boundary. `server.ts` no longer imports `pglite-backend.ts`, and `src/ports/factory.ts` is the only runtime adapter selector.

Tradeoffs:

- The `Ports` interface is flat and large. This is simple for tool delegation but makes future adapters implement the full surface at once.
- Account/control-plane methods are part of the same interface as data-plane methods. That is convenient today, but remote adapters may want separate control-plane clients.
- `createPorts` caches a singleton per process. This is correct for PGLite, but future multi-tenant or multi-backend deployments may need keyed adapter instances.

Recommended direction:

1. Keep the flat `Ports` interface for now.
2. Add conformance tests that every adapter must pass.
3. If a second backend is implemented, consider splitting `Ports` into nested clients or separate `DataPorts` and `ControlPorts` only when the second implementation proves the need.

## Security review

### Strong decisions

- Account JWT scopes are ignored; authorization uses scopes stored in the server database.
- Admin JWTs require issuer, audience, trusted key/JWKS, and `accounts:admin` scope.
- Dangerous MCP operations require both `confirm: true` and `HYPER_MCP_ALLOW_DANGEROUS=true`.
- Read/write scopes are checked per tool.
- Disabled accounts are rejected because account lookup filters active accounts.

### Gaps and risks

#### 1. HTTP and stdio auth semantics differ

HTTP `/mcp` blocks when auth is required but admin trust root is missing. `server.ts` only enforces auth inside tools when `config.authRequired && config.admin` is true. In stdio, this can produce unauthenticated default-account access when admin is absent.

Recommendation: make trust mode explicit:

- `authRequired=false`: local trusted mode, default account allowed.
- `authRequired=true`: tools must require an auth context regardless of transport.
- stdio should either require `authRequired=false` or support an explicit local identity config.

#### 2. Account issuer uniqueness is not enforced

`accountGetByIssuer` looks up the first active account for an issuer, but the schema does not enforce unique active issuers. Duplicate issuers could authenticate against an unintended account.

Recommendation: add uniqueness around active issuer identity. PGLite/Postgres partial unique indexes may be limited depending on support, so at minimum enforce in application logic during `accountCreate` and cover it with tests.

#### 3. Key/JWKS replacement semantics are ambiguous

Registration accepts either inline `publicJwk` or `jwksUrl`. Auth prefers stored inline keys if any exist; re-registering an account with a JWKS URL after an inline key may leave stale keys, causing the JWKS path not to be used.

Recommendation: define explicit lifecycle operations:

- replace keys
- add key
- remove key
- replace JWKS URL
- clear JWKS URL

For `/register`, either fully replace account auth material or reject updates that switch auth modes without an explicit flag.

#### 4. Read-only mode does not cover admin routes

`HYPER_MCP_READONLY` gates MCP tool writes, but `/register` and `/unregister` still mutate control-plane state.

Recommendation: decide whether read-only means data-plane only or entire service. If entire service, block admin mutation routes in read-only mode. If data-plane only, document that account lifecycle remains mutable.

#### 5. Public `/metrics`

`/metrics` is unauthenticated and exposes request/tool/auth-failure counters.

Recommendation: either document it as public operational metadata or protect it behind admin auth/config.

## Scalability and correctness review

### Data port

`dataFind` loads all documents for a collection, then filters, sorts, projects, and paginates in JS. Recorded indexes are metadata only. This is acceptable for compatibility and small datasets but not for large collections.

Recommendation:

- Document this as MVP behavior.
- Push common filters/sorts into SQL where possible.
- Add row limits or collection-size warnings.
- Treat `data_create_index` as compatibility metadata unless real SQL indexes are implemented.

### Cache port

`cacheIncr` is implemented as read-then-write. The README currently describes atomic counters, but concurrent increments can lose updates.

Recommendation:

- Either change docs from “atomic counters” to “counter helpers”, or implement SQL-level atomic increments.
- Preserve TTL semantics intentionally during increment/decrement and test that behavior.

### Blob port

Blobs are stored as base64 text in PGLite, with a 100MB object cap. Render disk is configured as 1GB.

Recommendation:

- Document this as local/PGLite MVP object storage.
- Lower default blob limits for hosted single-disk deployments or make the limit configurable.
- Future adapter should use object storage for real production blobs.

### Queue port

`queuePublish` computes the next offset with `max(offset_id)+1`, then inserts. Concurrent publishers can race. Partition support is partial; polling and subscriptions track a single `next_offset` rather than independent offsets per partition.

Recommendation:

- Document queue semantics as lightweight MVP, not Kafka-grade.
- Use a database sequence or transactional offset allocation for concurrency.
- Model subscription offsets per `(subscription_id, partition)` before claiming robust partition support.

### Search port

Search stores duplicated lowercased JSON text and filters in JS. It does not use a real full-text index or scoring.

Recommendation:

- Document as simple contains search.
- Consider PGLite/Postgres full-text features if available.
- Move scoring/query DSL expectations into “compatibility MVP” language.

## Observability and operations

Strengths:

- Structured JSON logs by default.
- Pretty local logging option.
- Request IDs are returned and logged.
- Basic counters exist for requests, tools, tool errors, and auth failures.
- Shutdown closes the cached backend on SIGINT/SIGTERM.

Gaps:

- Metrics are process-local and reset on restart.
- No latency histograms or per-tool error codes in metrics.
- Public metrics route is not listed in the README endpoint table.
- Health reports `backend: "pglite"` rather than using `config.backend`.
- MCP resource `scoutos://ports` also hardcodes `backend: "pglite"`.

Recommendations:

1. Update health/resource reporting to use `config.backend`.
2. Document `/metrics` or protect it.
3. Add per-tool latency summaries if operational diagnosis matters.
4. Include backend initialization failures in health/metrics once backend has been touched.

## Testing review

The current tests cover:

- PGLite data/cache/blob/queue/search behavior.
- Persistence across restart for selected paths.
- Account table/key/JWKS/audit behavior.
- Scope helper behavior.
- AsyncLocalStorage auth context propagation.
- Tenant isolation across major ports.
- Adapter factory behavior.

Important gaps:

1. Real JWT validation tests for `validateAdminJwt` and `validateAccountJwt`.
2. HTTP endpoint tests for `/register`, `/unregister`, and `/mcp` authorization failures/successes.
3. Concurrency tests for cache increments and queue publishing.
4. Read-only mode tests for both MCP tool writes and admin route mutations.
5. Tests for duplicate issuer behavior and key/JWKS replacement behavior.

Recommended next tests:

- Generate Ed25519 keys, sign admin JWT, call `validateAdminJwt`.
- Register an account, sign account JWT, call `validateAccountJwt`.
- Simulate duplicate issuer registration and assert deterministic rejection.
- Re-register account from publicJWK to JWKS URL and assert old keys are cleared or rejected.
- Fire concurrent `cache_incr` calls and define expected semantics.
- Fire concurrent queue publishes and assert unique offsets.

## Documentation gaps

The README is useful but should be aligned with current behavior:

- Test count appears stale.
- `/metrics` exists but is not in the endpoint table.
- `cache` says “atomic counters” but implementation is not atomic under concurrency.
- `data_create_index` records compatibility metadata rather than creating operational indexes.
- Blob signing returns `pglite://` pseudo URLs, not externally usable signed URLs.
- Queue behavior should be described as lightweight MVP semantics.
- Search should be described as simple in-process contains/match/term query, not a production search engine.
- Stdio auth/default-account behavior should be explicit.

## Prioritized recommendations

### P0 / High impact

1. **Make auth mode explicit and consistent.** Resolve HTTP vs stdio/default-account behavior. `authRequired=true` should never silently fall back to unauthenticated default-account tool execution.
2. **Enforce account issuer uniqueness.** Prevent ambiguous account lookup by issuer.
3. **Define key/JWKS replacement semantics.** Avoid stale keys and auth mode confusion during re-registration.
4. **Add real JWT and HTTP auth tests.** Cover admin/account validation and protected route behavior end to end.

### P1 / Medium impact

5. **Fix or document non-atomic counter behavior.** Prefer SQL-level atomic increments.
6. **Fix or document queue concurrency/partition semantics.** Use safer offset allocation before claiming robust queue behavior.
7. **Document MVP indexing/search/blob limitations.** Prevent users from assuming production-grade performance.
8. **Decide `/metrics` posture.** Public, protected, or disabled-by-config.
9. **Clarify read-only semantics for admin routes.** Decide data-plane-only vs full-service read-only.

### P2 / Lower impact

10. **Use `config.backend` in health/resource output.** Avoid drift as adapters are added.
11. **Split PGLite backend eventually.** `pglite-backend.ts` is manageable now, but each port could move into a separate implementation file once behavior grows.
12. **Add adapter conformance test harness.** Useful before adding `scoutos` or `memory` adapters.
13. **Make resource limits configurable.** Blob size, cache value size, find/search page max, queue poll max.

## Proposed near-term roadmap

### Phase 1 — Security boundary hardening

- Add explicit `HYPER_MCP_TRUST_MODE` or equivalent docs/logic for local stdio vs hosted HTTP.
- Ensure `authRequired=true` fails closed in tool handlers without auth context.
- Add duplicate issuer detection.
- Define replacement semantics for public keys vs JWKS URL.
- Add JWT validation and HTTP route tests.

### Phase 2 — Documentation and contract cleanup

- Update README endpoint table and test count.
- Add MVP limitations for every port.
- Add a port contract page that distinguishes compatibility behavior from production guarantees.
- Update health/resource backend reporting.

### Phase 3 — Correctness under concurrency

- Implement atomic cache increments.
- Implement transactional queue offset allocation.
- Add concurrency tests.
- Decide partition/subscription offset model.

### Phase 4 — Adapter readiness

- Build an adapter conformance suite from current PGLite tests.
- Keep `Ports` flat until a second backend creates real pressure to restructure.
- Add a `memory` adapter only if it gives test speed or local-dev value beyond PGLite.
- Treat `scoutos` as the first serious proof of the abstraction.

## Architectural verdict

The project has a clean MVP architecture with the right seam in the right place: MCP tools depend on a port interface, not storage details. That choice buys flexibility.

The next work should not be a broad rewrite. It should be boundary hardening: auth consistency, account identity uniqueness, clear key lifecycle, and honest docs about MVP semantics. After that, the codebase is well positioned to add a second backend without disturbing the tool surface.

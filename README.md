# hyper-mcp

MCP server exposing ScoutOS-style ports to agents, backed by persistent [PGLite](https://pglite.dev/):

- **data**: JSON document collections with Mongo-style queries (filters/sort run in-process; indexes are compatibility metadata)
- **cache**: JSON values with TTL, atomic counter helpers (increment/decrement are atomic under concurrency)
- **blob**: text/base64 file storage with metadata (base64 text in PGLite; `blob_sign` returns `pglite://` pseudo URLs for MVP, not externally usable signed URLs)
- **queue**: topics, subscriptions, poll/ack/nack/seek (lightweight MVP, not Kafka-grade; offsets are allocated atomically; partitions partial)
- **search**: persistent document indexes with simple contains/match/term query (no scoring or real full-text index)
- **auth**: application users, scrypt passwords, opaque session tokens, and one-time email/SMS codes (Convex Auth Library analogue; tenant-isolated by account_id)

## Quick start

```sh
npm install
npm run build
npm start    # HTTP server on :3000 (Render-ready)
# or
npm run start:stdio    # stdio MCP transport (local agent)
```

## Endpoints

| Route | Auth | Description |
|-------|------|-------------|
| `GET /` | public | Landing page |
| `GET /health` | public | Health check |
| `GET /metrics` | public or admin JWT | In-process metrics (public unless `HYPER_MCP_METRICS_PUBLIC=false`) |
| `POST /mcp` | account JWT | MCP streamable HTTP transport |
| `POST /register` | admin JWT | Register an agent account |
| `POST /unregister` | admin JWT | Disable an agent account |
| `POST /u/:accountId/:fn` | user session token (or public) | BaaS dynamic endpoint — call an account's authored function |

## Auth

### How it works

```
Admin (config env)  ──signs──>  admin JWT  ──calls──>  /register
                                                        |
                                                        v
Account (registered key)  <──stores──  public JWK or JWKS URL
       |
       └──signs──>  account JWT  ──calls──>  /mcp  ──scoped──>  port tools
```

1. Deploy with admin trust root env vars.
2. Admin signs a JWT and calls `/register` to create agent accounts.
3. Each agent signs JWTs with its private key and calls `/mcp`.

### Admin trust root

hyper-mcp supports a **list of trusted admin identity providers** (the Convex
`auth.config.ts` pattern): any OIDC provider (Clerk, WorkOS, Auth0, or a custom
Ed25519 key) can issue admin JWTs, and verification is **routed by the token's
`iss` claim** to the matching provider's key set. Configure either a single
legacy provider or a multi-provider list — not both.

#### Single provider (legacy, still supported)

```env
# Option A: inline public JWK
HYPER_MCP_ADMIN_PUBLIC_JWK='{"kty":"OKP","crv":"Ed25519","x":"...","kid":"admin-1"}'

# Option B: JWKS URL
HYPER_MCP_ADMIN_JWKS_URL=https://example.com/.well-known/jwks.json
```

Required metadata:

```env
HYPER_MCP_ADMIN_ISSUER=admin-agent
HYPER_MCP_ADMIN_AUDIENCE=hyper-mcp
HYPER_MCP_ADMIN_KID=admin-1   # optional
```

#### Multiple providers

Set `HYPER_MCP_ADMIN_PROVIDERS` to a JSON array of provider objects. Each
provider must declare `issuer`, `audience`, and exactly one of `publicJwk`
(inline JWK object or JSON string) or `jwksUrl`; `kid` and `id` are optional.
Issuers **must be unique** — verification selects a provider by the token's
`iss`, so a duplicate issuer is a startup error.

```env
HYPER_MCP_ADMIN_PROVIDERS='[
  {"issuer":"admin-agent","audience":"hyper-mcp","publicJwk":{"kty":"OKP","crv":"Ed25519","x":"...","kid":"admin-1"}},
  {"issuer":"clerk-admin","audience":"hyper-mcp","jwksUrl":"https://clerk.example.com/.well-known/jwks.json","kid":"clerk-1"}
]'
```

Mixing the legacy single-provider vars with `HYPER_MCP_ADMIN_PROVIDERS` is a
startup error (ambiguous admin config). With zero providers configured, `/register`
and `/unregister` return `503 admin_not_configured` and stdio refuses to start
in hosted trust mode.


Optional:

```env
HYPER_MCP_ADMIN_KID=admin-1
HYPER_MCP_JWKS_CACHE_SECONDS=300

# Resource limits (cap per request; defaults match prior hardcoded behavior)
HYPER_MCP_MAX_CACHE_BYTES=1048576        # reject cache values > 1 MiB (413 VALUE_TOO_LARGE)
HYPER_MCP_MAX_BLOB_BYTES=104857600       # reject blobs > 100 MiB (413 BLOB_FILE_TOO_LARGE)
HYPER_MCP_MAX_DATA_PAGE_SIZE=1000         # data_find page ceiling (caller limit clamped)
HYPER_MCP_MAX_BLOB_LIST_PAGE_SIZE=1000    # blob_list page ceiling
HYPER_MCP_MAX_QUEUE_POLL_BATCH=10000      # queue_poll batch ceiling
HYPER_MCP_MAX_SEARCH_PAGE_SIZE=10000      # search_query page ceiling
```

Without admin trust root, `/register` and `/unregister` return `503 admin_not_configured`.

### Generate an Ed25519 key pair

```sh
node -e "
const { generateKeyPairSync } = require('crypto');
const { exportJWK } = require('jose');
(async () => {
  const { publicKey, privateKey } = await generateKeyPairSync('Ed25519');
  const pub = await exportJWK(publicKey);
  const priv = await exportJWK(privateKey);
  console.log('PUBLIC JWK:', JSON.stringify(pub));
  console.log('PRIVATE JWK:', JSON.stringify(priv));
})();
"
```

### Sign an admin JWT

```sh
node -e "
const { SignJWT, importJWK } = require('jose');
(async () => {
  const privJwk = /* paste private JWK here */;
  const key = await importJWK(privJwk, 'Ed25519');
  const jwt = await new SignJWT({ scope: 'accounts:admin' })
    .setProtectedHeader({ alg: 'EdDSA', kid: privJwk.kid || 'admin-1' })
    .setIssuer('admin-agent')
    .setAudience('hyper-mcp')
    .setExpirationTime('1h')
    .sign(key);
  console.log(jwt);
})();
"
```

### Register an account

```sh
curl -X POST https://your-service.onrender.com/register \
  -H "Authorization: Bearer <admin-jwt>" \
  -H "Content-Type: application/json" \
  -d '{
    "accountId": "agent-tom",
    "name": "Tom'\''s agent",
    "issuer": "agent-tom",
    "audience": "hyper-mcp",
    "publicJwk": {"kty":"OKP","crv":"Ed25519","x":"...","kid":"key-1"},
    "ports": {
      "data:read": true,
      "data:write": true,
      "cache:read": true,
      "cache:write": true,
      "blob:read": true,
      "blob:write": true,
      "queue:read": true,
      "queue:write": true,
      "search:read": true,
      "search:write": true
    }
  }'
```

Response:

```json
{
  "ok": true,
  "accountId": "agent-tom",
  "scopes": ["data:read", "data:write", "cache:read", ...],
  "status": "active"
}
```

Re-registering an existing `accountId` **fully replaces** its auth material:
all previously stored inline keys and JWKS URLs are cleared before the new
`publicJwk` or `jwksUrl` is stored. Switching auth modes (inline JWK ↔ JWKS
URL) therefore deactivates the old credential. An `auth_replace` audit entry
records each replacement.

### Unregister an account

```sh
curl -X POST https://your-service.onrender.com/unregister \
  -H "Authorization: Bearer <admin-jwt>" \
  -H "Content-Type: application/json" \
  -d '{"accountId":"agent-tom","confirm":true}'
```

### Call MCP with account JWT

```sh
node -e "
const { SignJWT, importJWK } = require('jose');
(async () => {
  const privJwk = /* agent private JWK */;
  const key = await importJWK(privJwk, 'Ed25519');
  const jwt = await new SignJWT({})
    .setProtectedHeader({ alg: 'EdDSA', kid: privJwk.kid || 'key-1' })
    .setIssuer('agent-tom')
    .setAudience('hyper-mcp')
    .setExpirationTime('1h')
    .sign(key);
  console.log(jwt);
})();
"
```

```sh
curl -X POST https://your-service.onrender.com/mcp \
  -H "Authorization: Bearer <account-jwt>" \
  -H "Content-Type: application/json" \
  -d '{"jsonrpc":"2.0","method":"tools/list","id":1}'
```

## Scopes

| Scope | Tools |
|-------|-------|
| `data:read` | data_get, data_find, data_count, data_list_indexes, data_list_collections, data_health |
| `data:write` | data_create, data_replace, data_update, data_delete, data_bulk, data_create_index |
| `data:dangerous` | data_drop_index, data_drop_collection |
| `cache:read` | cache_get, cache_exists, cache_ttl |
| `cache:write` | cache_set, cache_delete, cache_incr, cache_decr |
| `blob:read` | blob_get_text, blob_get_base64, blob_meta, blob_list, blob_sign |
| `blob:write` | blob_put_text, blob_put_base64, blob_delete, blob_copy |
| `queue:read` | queue_list_topics, queue_poll |
| `queue:write` | queue_create_topic, queue_publish, queue_publish_batch, queue_subscribe, queue_ack, queue_nack, queue_seek |
| `queue:dangerous` | queue_delete_topic |
| `search:read` | search_health, search_get_doc, search_query, search_simple_query, search_count |
| `search:write` | search_create_index, search_index_doc, search_delete_doc, search_bulk |
| `search:dangerous` | search_delete_index |
| `auth:read` | auth_get_user, auth_find_users, auth_verify_password, auth_verify_session, auth_list_sessions, auth_verify_code, auth_health |
| `auth:write` | auth_create_user, auth_update_user, auth_set_password, auth_create_session, auth_revoke_session, auth_create_code |
| `auth:dangerous` | auth_delete_user |
| `app:read` | app_get_function, app_list_functions |
| `app:write` | app_register_function |
| `app:dangerous` | app_delete_function |
| `accounts:admin` | all of the above (wildcard) |

`{port}:admin` grants all scopes for that port.

## Auth port

The `auth` port lets an account manage **its own application's** end-user
identity and sign-in state — users, passwords, sessions, and one-time codes —
backed by PGLite and scoped like the other ports. This is the Convex Auth
Library analogue (users + session tokens + password + OTP), exposed as MCP
tools; it is separate from the server's own admin/account auth.

- **Users** — `auth_create_user`, `auth_get_user`, `auth_find_users`,
  `auth_update_user`, `auth_delete_user` (dangerous). `email`/`username` are
  unique within an account. `auth_get_user`/`auth_find_users` never return
  credentials.
- **Passwords** — `auth_set_password` (scrypt-hashed with a per-user salt) and
  `auth_verify_password` (returns `{ valid }`; no hash is ever returned).
- **Sessions** — `auth_create_session` issues an opaque url-safe token and
  returns `{ token, expiresAt }`; only a SHA-256 hash of the token is stored,
  so a DB leak does not expose live sessions. `auth_verify_session` resolves
  `{ valid, userId, expiresAt }`; `auth_revoke_session` revokes; `auth_list_sessions`
  lists active sessions (without token hashes).
- **One-time codes** — `auth_create_code` (channel `email`|`sms`, `target`,
  optional `userId`, `ttlSeconds`, `maxAttempts`) generates a 6-digit code and
  stores only its hash; one active code per `(account, target)` (creating
  replaces any prior). `auth_verify_code` consumes it on success and enforces
  the attempt cap. Delivery of the code (email/SMS) is the caller's
  responsibility — hyper-mcp only generates and verifies.

Default session TTL is configurable:

```env
HYPER_MCP_AUTH_SESSION_TTL_SECONDS=86400   # default 1 day
```

All `auth` data is tenant-isolated by `account_id`; read tools never return
password hashes, session tokens, or code values.

## BaaS adapter (functions, identity-at-boundary, user-scoped data)

The BaaS adapter lets an account build a web app on hyper-mcp **without writing
or hosting a separate backend service**. You register JS functions into hyper-mcp
(Convex-style) and a static frontend (e.g. a ZenBin page) calls them directly at
`POST /u/:accountId/:fn` with a **user** session token — no account JWT leaves
the server. This is the last swappable-substrate layer: prototype impls now, prod
impls behind the same contract later.

### Adapter contracts (prototype vs prod)

| Contract | Prototype (now) | Prod (contract-only) |
|---|---|---|
| IdentityResolver | Opaque session token from the auth port (`auth_create_session`) | OIDC JWT verified via JWKS (reuses the multi-provider admin trust machinery) |
| FunctionRuntime | `node:vm` restricted context — **trusted dev code only** | Daytona sandbox (real isolation for untrusted/multi-tenant code) |
| User-scoped data (RLS) | App-level `user_id` filter/stamp in SQL via `ctx.db` | Engine-enforced Postgres RLS policies + `SET LOCAL app.user_id` |

> ⚠️ The prototype `FunctionRuntime` (`node:vm`) is **NOT a security barrier** —
> it is for code the account owner authors in dev. It is escape-able by
> sophisticated code. Do **not** run third-party/untrusted functions on it in
> hosted mode; use the Daytona adapter for that. A startup warning is logged.

### Functions

A function is a JS expression evaluating to an async handler with a scoped `ctx`:

```js
async (ctx) => {
  // ctx.user = { id, accountId } | null   (null for public functions)
  // ctx.body = the parsed HTTP request body
  // ctx.db  = user-scoped data (get/find/create/update/delete/count) — RLS
  // ctx.auth = createUser/getUser/findUsers/setPassword/verifyPassword/createSession
  // ctx.kv  = per-user JSON KV (set/get/delete)
  const u = await ctx.auth.createUser({ email: ctx.body.email });
  await ctx.auth.setPassword(u.userId, ctx.body.password);
  const s = await ctx.auth.createSession(u.userId);
  return { userId: u.userId, token: s.token };
}
```

`ctx.db` is structurally scoped to `ctx.user.id` — a function **cannot** address
another user's rows. Public functions (e.g. `signup`/`login`) run with
`ctx.user = null` and use `ctx.auth` only; `ctx.db`/`ctx.kv` throw for public
functions.

### Registering functions (via MCP)

An agent or account calls `app_register_function` (app:write) with the source and
a `public` flag; `app_list_functions`/`app_get_function` (app:read);
`app_delete_function` (app:dangerous). Re-registering bumps the version.

### Calling functions (browser/frontend)

```sh
# public function — no token
curl -X POST https://your-service.onrender.com/u/myapp/signup \
  -H "Content-Type: application/json" \
  -d '{"email":"ada@x.com","password":"pw"}'

# authed function — user session token from signup/login
curl -X POST https://your-service.onrender.com/u/myapp/listPosts \
  -H "Authorization: Bearer <session-token>"
```

```env
HYPER_MCP_FUNCTION_TIMEOUT_MS=5000   # wall-clock cap per function call
# Browser CORS for static BaaS frontends (ZenBin, localhost demos, etc.).
# Default "*" works with bearer-token fetches and no cookies. Set a comma-separated
# allowlist to enforce specific origins, or an empty value to disable CORS headers.
HYPER_MCP_BAAS_CORS_ORIGINS=*
```

Function source, `app_data`, and `app_functions` are all tenant-isolated by
`account_id`; `app_data` is additionally scoped by `user_id` (RLS).


### Secure ZenBin blog demo

This repo includes a small end-to-end demo generator for a private ZenBin page
that fetches fake blog posts from hyper-mcp BaaS user-scoped `app_data`:

```sh
# Generate only; useful for previewing/publishing the static page shell.
npx tsx scripts/zenbin-blog-demo.ts --generate-only --out dist/zenbin-blog-demo.html

# Provision the BaaS account/functions on a configured service, then generate.
# Requires HYPER_MCP_ADMIN_PRIVATE_JWK matching the service admin trust root.
npx tsx scripts/zenbin-blog-demo.ts --base-url https://hyper-mcp.onrender.com
```

The generated browser page contains only the service URL and account id. It does
not include admin/account JWTs or private keys; it calls a public `demoAuth`
function to mint an end-user session token, then calls authenticated
`ensureBlogPosts` and `listBlogPosts` functions that use `ctx.db`. Publish the
output with ZenBin sign-to-read/private access for the secure-page version.

### Prod adapters (swappable, config-selected)

The prototype impls are the default. Flip env vars to route through the prod
adapters behind the same contracts — your functions and endpoints do not change:

| Contract | Prototype (default) | Prod | Env to select prod |
|---|---|---|---|
| IdentityResolver | opaque session token | OIDC JWT via JWKS | `HYPER_MCP_BAAS_IDENTITY=oidc` + `HYPER_MCP_BAAS_OIDC_PROVIDERS` |
| FunctionRuntime | `node:vm` trusted-context | Daytona sandbox | `HYPER_MCP_BAAS_RUNTIME=daytona` + `DAYTONA_API_KEY` + `HYPER_MCP_BAAS_CAP_URL` |
| app_data (RLS) | PGLite app-level wrapper | external Postgres engine RLS | `HYPER_MCP_APP_DATA_BACKEND=pg` + `HYPER_MCP_APP_DATA_PG_URL` |

```env
# OIDC boundary: bind an issuer to a hyper-mcp account; end users' `sub` is the userId.
HYPER_MCP_BAAS_IDENTITY=oidc
HYPER_MCP_BAAS_OIDC_PROVIDERS='[{"issuer":"https://clerk.example.com","audience":"hyper-mcp","jwksUrl":"https://clerk.example.com/.well-known/jwks.json","accountId":"myapp"}]'

# Daytona runtime: real isolation for untrusted functions. CAP_URL is the
# public base URL the sandbox calls back to for capabilities (must be reachable
# from the Daytona sandbox). A per-process secret signs the cap tokens.
HYPER_MCP_BAAS_RUNTIME=daytona
DAYTONA_API_KEY=...                      # plus DAYTONA_* env the SDK expects
HYPER_MCP_BAAS_CAP_URL=https://your-service.onrender.com
HYPER_MCP_DAYTONA_TIMEOUT_MS=20000

# External Postgres engine RLS for app_data (FORCE ROW LEVEL SECURITY + policy).
HYPER_MCP_APP_DATA_BACKEND=pg
HYPER_MCP_APP_DATA_PG_URL=postgres://user:pass@host:5432/db
```

> The Daytona runtime is the security barrier the prototype `node:vm` runtime
> is not — run untrusted/multi-tenant functions only with `baasRuntime=daytona`.
> The Postgres backend makes the **database** the RLS authority (engine-enforced
> `WITH CHECK`), so a buggy query cannot leak another user's rows.

**Tests:** OIDC + internal-cap + Daytona (mocked) run by default; the real
Daytona and real-Postgres tests are opt-in:
```sh
DAYTONA_API_KEY=... npm test -- daytona
PG_TEST_URL=postgres://... npm test -- appdata-pg
```

The full external-Postgres `Ports` adapter (data/cache/blob/queue/search/auth on
external Postgres) is a follow-up; this cycle proves engine RLS on `app_data`.

## Configuration

```env
# PGLite persistence
HYPER_MCP_PGLITE_DIR=.hyper-mcp/pgdata

# Safety
HYPER_MCP_READONLY=false            # blocks MCP writes AND admin account mutations (/register, /unregister)
HYPER_MCP_ALLOW_DANGEROUS=false
HYPER_MCP_METRICS_PUBLIC=true       # set false to require an admin JWT for /metrics

# Backend adapter
HYPER_MCP_BACKEND=pglite    # pglite | scoutos (future) | memory (future)

# Auth / trust mode
HYPER_MCP_TRUST_MODE=hosted          # hosted (auth required) | local (trusted, default account)
HYPER_MCP_AUTH_REQUIRED=true         # legacy flag; trust mode is the source of truth
HYPER_MCP_ADMIN_PUBLIC_JWK=...       # or HYPER_MCP_ADMIN_JWKS_URL=...
HYPER_MCP_ADMIN_ISSUER=admin-agent
HYPER_MCP_ADMIN_AUDIENCE=hyper-mcp
HYPER_MCP_ADMIN_KID=admin-1
HYPER_MCP_JWKS_CACHE_SECONDS=300
```

### Resource limits

Resource caps are configurable per deployment. Size caps reject oversize
writes with a 413; page/batch caps clamp the caller's `limit`/`size` down to
the ceiling. Defaults match the prior hardcoded behavior, so existing
deployments keep working. Set any of them to tighten for your workload:

- `HYPER_MCP_MAX_CACHE_BYTES` — max bytes for a cache value (413 `VALUE_TOO_LARGE`).
- `HYPER_MCP_MAX_BLOB_BYTES` — max bytes for a blob payload (413 `BLOB_FILE_TOO_LARGE`).
- `HYPER_MCP_MAX_DATA_PAGE_SIZE` — `data_find` page ceiling.
- `HYPER_MCP_MAX_BLOB_LIST_PAGE_SIZE` — `blob_list` page ceiling.
- `HYPER_MCP_MAX_QUEUE_POLL_BATCH` — `queue_poll` batch ceiling.
- `HYPER_MCP_MAX_SEARCH_PAGE_SIZE` — `search_query` page ceiling.

Values must be positive integers; a non-integer or non-positive value fails
startup with a clear config error.

### Trust mode

`HYPER_MCP_TRUST_MODE` is the security boundary:

- **`hosted`** — auth is required. `/mcp` validates an account JWT; tool handlers
  fail closed with `AUTH_REQUIRED` when no auth context is present. Without an
  admin trust root, HTTP `/mcp` returns `503 admin_not_configured` and the stdio
  transport refuses to start. Use this for any deployed/shared service.
- **`local`** — trusted mode for stdio / local dev. No auth is required and tools
  run as the `default` account. Never use `local` for a shared deployment.

If `HYPER_MCP_TRUST_MODE` is unset, it is inferred from `HYPER_MCP_AUTH_REQUIRED`
(`true` → `hosted`, `false` → `local`) and a startup warning is logged. Set it
explicitly in production.

To run without auth (local dev):

```env
HYPER_MCP_TRUST_MODE=local
HYPER_MCP_AUTH_REQUIRED=false
```

All port data uses `account_id` for tenant isolation. In local mode (or any
unauthenticated flow), `account_id` defaults to `"default"`.

## Deploy to Render

`render.yaml` is included. Create a Blueprint from the repo:

```
https://render.com/deploy?repo=https://github.com/scoutos-labs/hyper-mcp
```

Set admin env vars in Render's dashboard after first deploy.

## Development

```sh
npm run typecheck
npm run build
npm test          # see output for the current count (ports, auth, tenant isolation, JWT, HTTP routes, trust mode, concurrency)
```

### Smoke tests

The smoke script checks public health/landing/metrics endpoints, MCP method guards, and the expected unauthenticated auth posture for both open local dev and protected deployments.

```sh
npm run smoke:local   # expects a local server at http://localhost:3000
npm run smoke:render  # checks https://hyper-mcp.onrender.com
npm run smoke:all     # local + Render
```

Custom targets and authenticated MCP checks:

```sh
npm run smoke -- https://your-service.onrender.com
SMOKE_ACCOUNT_JWT=<account-jwt> npm run smoke:render
```

## Agent integration

`scripts/agent-integration.ts` verifies the end-to-end path a real agent takes:
it uses the official MCP client SDK over the streamable HTTP transport to
authenticate with a signed account JWT, run the `initialize` handshake, list
tools, and call a representative write+read tool on each of the five ports
(data, cache, blob, queue, search), plus a tenant-isolation check between two
agents. This is the proof that a ScoutOS-hosted agent can leverage hyper-mcp.

Self-contained (boots an in-process hyper-mcp with generated admin keys):

```sh
npm run integrate
```

Against a running deployment (the target must have an admin trust root
configured whose private key you hold):

```sh
HYPER_MCP_ADMIN_PRIVATE_JWK='{"kty":"OKP","crv":"Ed25519","d":"...","kid":"admin-1"}' \
  npm run integrate:url -- --url https://hyper-mcp.onrender.com
```

If the target reports `admin_not_configured`, set `HYPER_MCP_ADMIN_PUBLIC_JWK`
(on the deploy) to the public counterpart of `HYPER_MCP_ADMIN_PRIVATE_JWK`
first, then retry. The same flow runs as a vitest in
`test/agent-integration.test.ts`.

## License

MIT

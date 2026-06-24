# hyper-mcp

MCP server exposing ScoutOS-style ports to agents, backed by persistent [PGLite](https://pglite.dev/):

- **data**: JSON document collections with Mongo-style queries
- **cache**: JSON values with TTL, atomic counters
- **blob**: text/base64 file storage with metadata
- **queue**: topics, subscriptions, poll/ack/nack/seek
- **search**: persistent document indexes with full-text query

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
| `POST /mcp` | account JWT | MCP streamable HTTP transport |
| `POST /register` | admin JWT | Register an agent account |
| `POST /unregister` | admin JWT | Disable an agent account |

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

Configure exactly one of:

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
```

Optional:

```env
HYPER_MCP_ADMIN_KID=admin-1
HYPER_MCP_JWKS_CACHE_SECONDS=300
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
| `accounts:admin` | all of the above (wildcard) |

`{port}:admin` grants all scopes for that port.

## Configuration

```env
# PGLite persistence
HYPER_MCP_PGLITE_DIR=.hyper-mcp/pgdata

# Safety
HYPER_MCP_READONLY=false
HYPER_MCP_ALLOW_DANGEROUS=false

# Auth
HYPER_MCP_AUTH_REQUIRED=true
HYPER_MCP_ADMIN_PUBLIC_JWK=...       # or HYPER_MCP_ADMIN_JWKS_URL=...
HYPER_MCP_ADMIN_ISSUER=admin-agent
HYPER_MCP_ADMIN_AUDIENCE=hyper-mcp
HYPER_MCP_ADMIN_KID=admin-1
HYPER_MCP_JWKS_CACHE_SECONDS=300
```

To run without auth (local dev):

```env
HYPER_MCP_AUTH_REQUIRED=false
```

All port data uses `account_id` for tenant isolation. Without auth, `account_id` defaults to `"default"`.

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
npm test          # 40 tests across ports, auth, and tenant isolation
```

## License

MIT

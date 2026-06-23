# hyper-mcp

MVP MCP server exposing ScoutOS-style ports to agents, backed by persistent [PGLite](https://pglite.dev/):

- data: JSON document collections
- cache: JSON values with TTL
- blob: text/base64 objects
- queue: topics, subscriptions, poll/ack
- search: simple persistent document indexes

## Run

```sh
npm install
npm run build
HYPER_MCP_PGLITE_DIR=.hyper-mcp/pgdata node dist/index.js
```

Default persistent directory: `.hyper-mcp/pgdata`.

Safety env vars:

```sh
HYPER_MCP_READONLY=true          # blocks writes
HYPER_MCP_ALLOW_DANGEROUS=true  # required for drop/delete-index/delete-topic
```

# Code Context

## Files Retrieved
1. `package.json` (lines 1-28) - entry points, build/start scripts, MCP/PGLite/JWT dependencies.
2. `src/index.ts` (lines 1-17) - stdio MCP runtime entry point.
3. `src/http.ts` (lines 1-205) - HTTP runtime, public/admin/MCP routes, lazy backend lifecycle.
4. `src/server.ts` (lines 1-138) - MCP server/resource/tool registration and scope/write/dangerous enforcement.
5. `src/config.ts` (lines 1-53) - environment-driven config and admin trust root parsing.
6. `src/auth.ts` (lines 1-164) - JWT validation, scope parsing, account auth model.
7. `src/auth-context.ts` (lines 1-20) - AsyncLocalStorage auth bridge for HTTP MCP tool calls.
8. `src/auth-routes.ts` (lines 1-126) - admin-protected account registration/unregistration flow.
9. `src/ports/types.ts` (lines 1-139) - adapter boundary for data/cache/blob/queue/search/account ports.
10. `src/ports/factory.ts` (lines 1-37) - backend adapter selection and cached singleton lifecycle.
11. `src/pglite-backend.ts` (lines 1-510) - concrete persistent PGLite adapter and schema for all ports.
12. `src/mongo.ts` (lines 1-142) - in-process Mongo-style filtering, sorting, updates, projection.
13. `src/logger.ts` (lines 1-155) - structured logging, in-process metrics, request logger.
14. `test/tenant-isolation.test.ts` (lines 1-151) - confirms `account_id` isolation across ports.
15. `test/auth.test.ts` (lines 1-129) - account store and scope helper behavior.
16. `adapter-swap-plan.md` (lines 1-220) - intended adapter abstraction direction and acceptance criteria.

## Key Code

### Runtime entry points
```ts
// src/index.ts:7-11
const config = loadConfig();
const server = createServer(config, () => createPorts(config));
const transport = new StdioServerTransport();
await server.connect(transport);
```

```ts
// src/http.ts:27-35
let portsPromise: Promise<Ports> | undefined;
const getPorts = () => {
  portsPromise ??= createPorts(config).then(ports => {
    logger.info("Backend ready", { backend: config.backend, pgDir: config.pgDir });
    return ports;
  });
  return portsPromise;
};
```

### HTTP MCP request flow
```ts
// src/http.ts:82-128
app.post("/mcp", async (req, res) => {
  if (config.authRequired) {
    if (!config.admin) return res.status(503).json(...);
    const token = extractBearer(req.headers.authorization);
    const ports = await getPorts();
    const authCtx = await validateAccountJwt(token, config, ports);
    req.__auth = authCtx;
  }

  const requestServer = createServer(config, getPorts);
  const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
  await requestServer.connect(transport);
  await runWithAuth(req.__auth, () => transport.handleRequest(req, res, req.body));
});
```

### Tool boundary and authorization
```ts
// src/server.ts:35-58
function tool(name, description, inputSchema, requiredScope, handler, readOnly = false) {
  server.registerTool(name, ..., async (args) => {
    const ports = await getPorts();
    let accountId: string | undefined;
    if (config.authRequired && config.admin) {
      const authCtx = getAuthContext();
      if (!authCtx) throw new PortError("AUTH_REQUIRED", "Authentication required", 401);
      if (!hasScope(authCtx.scopes, requiredScope)) throw new PortError("FORBIDDEN", ...);
      accountId = authCtx.accountId;
    }
    return jsonResult(await handler(args, ports, accountId));
  });
}
```

### Adapter boundary
```ts
// src/ports/types.ts:137-139
export interface Ports extends DataPort, CachePort, BlobPort, QueuePort, SearchPort, AccountPort {
  close?(): Promise<void>;
}
```

```ts
// src/ports/factory.ts:9-29
export async function createPorts(config: Config): Promise<Ports> {
  if (cachedPorts) return cachedPorts;
  switch ((config.backend || "pglite") as BackendType) {
    case "pglite":
      cachedPorts = new PgliteBackend(config.pgDir) as unknown as Ports;
      return cachedPorts;
    case "scoutos":
    case "memory":
      throw new PortError("BACKEND_NOT_IMPLEMENTED", ...);
  }
}
```

### PGLite storage/auth shape
- `src/pglite-backend.ts:23-147` creates all tables. Every data plane table has `account_id`; most primary keys are composite `(account_id, logical_key...)`.
- `src/pglite-backend.ts:155-157` maps missing `accountId` to `DEFAULT_ACCOUNT`.
- `src/pglite-backend.ts:457-507` implements account CRUD, key/JWKS URL storage, and audit logging.

### Auth model
- Admin JWTs are validated against env-configured inline JWK or JWKS URL, issuer, and audience; they must include `accounts:admin` (`src/auth.ts:53-99`).
- Account JWTs are decoded only to find issuer, then verified using DB-registered keys/JWKS and DB-stored issuer/audience (`src/auth.ts:103-138`).
- Runtime scopes come from the account DB record, not the JWT payload (`src/auth.ts:140-149`).
- `hasScope` permits exact scope, per-port `*:admin` (`data:admin` style), or global `accounts:admin` (`src/auth.ts:33-39`).

## Architecture

### Module responsibilities
- `config.ts`: central env parser; defaults to persistent PGLite dir `.hyper-mcp/pgdata`, `authRequired=true`, dangerous ops disabled, backend `pglite`.
- `http.ts`: Express-style MCP app, public landing/health/metrics, admin account routes, protected `/mcp`, lazy `Ports` initialization, shutdown cleanup.
- `index.ts`: local stdio transport using the same `createServer` and adapter factory.
- `server.ts`: transport-agnostic MCP tool/resource catalog. It performs tool-level scope checks plus `readOnly`/`allowDangerous` gates, then delegates all storage to `Ports`.
- `auth.ts` + `auth-routes.ts`: separates admin plane (`/register`, `/unregister`) from account data plane (`/mcp`), with account scopes stored server-side.
- `ports/types.ts` + `factory.ts`: backend adapter contract and selector. Current concrete adapter is flat (methods like `dataCreate`) rather than nested by port.
- `pglite-backend.ts`: monolithic adapter for all ports and account/auth persistence.
- `mongo.ts`: compatibility helpers used by the PGLite data port for in-memory filters/projections/updates.
- `logger.ts`: structured logs and volatile in-process metrics exposed at `/metrics`.

### HTTP flow
1. Process starts, loads config, creates MCP Express app. Backend is not initialized until first auth or MCP request (`src/http.ts:27-35`).
2. Public `GET /`, `GET /health`, and `GET /metrics` do not require auth (`src/http.ts:42-61`).
3. `POST /register` and `/unregister` validate an admin JWT, then create/disable account rows and keys/JWKS URLs (`src/auth-routes.ts:9-124`).
4. `POST /mcp` validates an account JWT if `authRequired`; the JWT maps to an active account by issuer and uses DB-stored scopes.
5. Each HTTP MCP POST creates a fresh `McpServer` and stateless `StreamableHTTPServerTransport`, but reuses the cached `Ports` backend (`src/http.ts:117-127`).
6. Auth context is passed to tool handlers through `AsyncLocalStorage` because the MCP SDK transport does not pass the Express request object (`src/auth-context.ts:4-20`).

### Stdio flow
- `src/index.ts` creates one MCP server over `StdioServerTransport`. It uses the same config and backend factory but has no HTTP bearer-token step and no `runWithAuth` wrapper.
- Consequence: stdio behavior depends on config/admin state. If `authRequired && admin` is true, tool handlers fail with `AUTH_REQUIRED`; if `admin` is absent, tool handlers do not enforce scopes and write to `DEFAULT_ACCOUNT`.

### Data/auth boundaries
- The main tenant boundary is the `accountId` first argument on each port interface method (`src/ports/types.ts:38-132`). HTTP tools pass the authenticated account id; unauthenticated/default flows pass `undefined` and become `default` in PGLite.
- PGLite schema consistently includes `account_id` on data/cache/blob/queue/search tables (`src/pglite-backend.ts:26-110`), and tenant tests cover isolation across major ports.
- Admin/account metadata is stored in the same PGLite database as tenant data (`src/pglite-backend.ts:113-146`). That simplifies deployment but couples auth availability to the data backend.

### Backend adapter design
- The adapter boundary is established but minimal: `Ports` is one large flat interface, `PgliteBackend implements Ports`, and `createPorts` caches a process-wide singleton.
- Future adapters (`scoutos`, `memory`) are config-recognized but not implemented (`src/ports/factory.ts:21-26`).
- `server.ts` depends only on `Ports`, so tool surface changes should not be required for backend swaps. However, the flat interface plus account/auth methods means remote adapters must implement both data plane and control plane semantics.

### Key risks / review notes
- **Auth bypass/ambiguity in stdio/default account:** tool enforcement is gated on `config.authRequired && config.admin` (`src/server.ts:47`). With default `authRequired=true` but no admin trust root, stdio tools run unauthenticated as `DEFAULT_ACCOUNT`; HTTP `/mcp` instead returns 503. This is an inconsistent security boundary.
- **Admin routes ignore `readOnly`:** `/register` and `/unregister` mutate account tables even when `HYPER_MCP_READONLY=true`; read-only is enforced only in MCP tool handlers.
- **Public metrics:** `/metrics` is unauthenticated and exposes request/tool/error/auth-failure counters (`src/http.ts:59-61`, `src/logger.ts:92-118`). Decide if acceptable for hosted deployments.
- **Concurrency correctness:** `cacheIncr` is read-then-update (`src/pglite-backend.ts:279-287`) and `queuePublish` computes `max(offset)+1` then inserts (`src/pglite-backend.ts:348-355`); concurrent calls can lose increments or collide offsets.
- **Performance ceiling:** `dataFind` loads all docs for a collection and filters/sorts in JS (`src/pglite-backend.ts:195-204`); `searchQuery` loads all search docs and filters in JS (`src/pglite-backend.ts:442-453`). Recorded indexes are compatibility metadata only.
- **Resource/storage pressure:** blobs are stored as base64 text inside PGLite, up to 100MB each (`src/pglite-backend.ts:9-10`, `292-300`); search text is full JSON string duplication.
- **Account issuer uniqueness:** schema does not enforce unique `issuer`; `accountGetByIssuer` returns the first active row (`src/pglite-backend.ts:113-122`, `472-477`). Duplicate issuers could authenticate against an unintended account.
- **Input validation gaps:** zod schemas are shallow (`z.any`, `AnyObj`), arbitrary regex filters are compiled directly in JS (`src/mongo.ts:25-40`), TTL/partition/topic/key constraints are limited.
- **Hardcoded backend reporting:** health and MCP resource report `pglite` rather than `config.backend` (`src/http.ts:47-56`, `src/server.ts:31-33`).
- **Single-process persistence assumption:** adapter factory caches one PGLite instance per process; deployment needs a writable persistent filesystem and careful handling of multi-instance scaling.

## Start Here
Open `src/http.ts` first. It shows the actual production runtime boundaries: public/admin/MCP routes, lazy backend creation, account JWT validation, AsyncLocalStorage auth handoff, stateless per-request MCP server creation, and shutdown behavior. Then follow into `src/server.ts` for tool authorization/delegation and `src/pglite-backend.ts` for persistence semantics.

# Adapter Swap Plan

## Goal

Extract port interfaces from the concrete `PgliteBackend` class so the MCP server depends on `Ports` interfaces, not a specific implementation. This unblocks:

- Swapping PGLite for ScoutOS remote adapters later
- Publishing the port interfaces as an npm package
- Running tests against any adapter implementation
- Adding new backends without touching `server.ts`

## Current State

```
MCP tools → server.ts → PgliteBackend (concrete class, ~500 lines)
```

- `server.ts` imports and calls `PgliteBackend` methods directly
- `http.ts` lazy-loads `PgliteBackend` via dynamic import
- No interface boundary between server logic and backend implementation
- All 48 tests pass against PgliteBackend

## Target State

```
MCP tools → server.ts → Ports interface
                         ↑
          ┌──────────────┼──────────────┐
          │              │              │
   PgliteBackend   ScoutOSRemote   MemoryBackend
   (current)       (future)        (future)
```

## Non-Goals

- Building the ScoutOS remote adapter (future work)
- Splitting into separate npm packages (future work)
- Building a separate memory adapter (PGLite in-memory mode already works)
- Changing the existing tool surface or API behavior

## Step 1 — Define port interfaces

**Work**

Create `src/ports/types.ts` with:

- `DataPort` interface — all data methods with `accountId` first param
- `CachePort` interface — all cache methods
- `BlobPort` interface — all blob methods
- `QueuePort` interface — all queue methods
- `SearchPort` interface — all search methods
- `Ports` bundle interface — `{ data, cache, blob, queue, search }`
- Re-export shared types (`Doc`, `FindOptions`, `FindResult`, etc.) from `mongo.ts`

Each interface method signature must exactly match what `PgliteBackend` currently exposes.

**Acceptance criteria**

- `src/ports/types.ts` compiles with zero errors
- Every method on `PgliteBackend` has a corresponding interface method with matching signature
- No behavior changes — interfaces are types only, no runtime code
- `npm run typecheck` passes

---

## Step 2 — Make PgliteBackend implement Ports

**Work**

- Add `implements Ports` to `PgliteBackend` class declaration
- Import port interfaces from `src/ports/types.ts`
- Fix any signature mismatches discovered by TypeScript
- Remove the `DEFAULT_ACCOUNT` constant from the class — move to config or a shared constant

**Acceptance criteria**

- `PgliteBackend` implements all 5 port interfaces
- TypeScript confirms full compliance (no missing methods)
- All 48 existing tests pass unchanged
- `npm run typecheck` passes
- `npm test` — 48 tests passing

---

## Step 3 — Refactor server.ts to depend on Ports

**Work**

- Change `createServer` signature from `(config, getBackend: () => Promise<PgliteBackend>)` to `(config, getPorts: () => Promise<Ports>)`
- Replace all `PgliteBackend` type references with `Ports`
- Tool handlers call `ports.data.create(...)`, `ports.cache.get(...)`, etc. instead of `backend.dataCreate(...)`
- Keep auth context (AsyncLocalStorage), scope enforcement, logging, and metrics unchanged

**Acceptance criteria**

- `server.ts` has zero imports from `pglite-backend.ts`
- `server.ts` imports only from `ports/types.ts`, `config.ts`, `auth.ts`, `auth-context.ts`, `errors.ts`, `logger.ts`
- All 48 tests pass
- `npm run typecheck` passes
- `npm test` — 48 tests passing

---

## Step 4 — Create adapter factory

**Work**

Create `src/ports/factory.ts`:

- `createPorts(config: Config): Promise<Ports>` function
- Reads `config.backend` (new field) to select adapter
- Currently supports only `"pglite"` — returns `new PgliteBackend(config.pgDir)`
- Throws clear error for unknown backend
- Future: `"scoutos"` returns ScoutOS remote adapters, `"memory"` returns in-memory

Add to `Config`:

```ts
backend: "pglite" | "scoutos" | "memory";
```

Read from `HYPER_MCP_BACKEND` env var, default `"pglite"`.

**Acceptance criteria**

- `createPorts("pglite")` returns a `Ports` instance backed by PgliteBackend
- Unknown backend name throws `PortError` with clear message
- Factory is the single place that knows about concrete adapter classes
- `npm run typecheck` passes

---

## Step 5 — Refactor http.ts to use factory

**Work**

- Replace lazy `PgliteBackend` dynamic import with `createPorts(config)` call
- Pass `getPorts` to `createServer` instead of `getBackend`
- Update auth route proxy to delegate to `Ports` interface methods
- Keep lazy initialization pattern (only create backend on first request)
- Add graceful PGLite shutdown in `shutdown()` handler

**Acceptance criteria**

- `http.ts` has zero direct imports from `pglite-backend.ts`
- `http.ts` imports `createPorts` from `ports/factory.ts`
- Server starts, `/health` and `/` work without initializing backend
- Backend initializes on first MCP or auth request
- Graceful shutdown closes the backend
- All 48 tests pass
- `npm test` — 48 tests passing

---

## Step 6 — Refactor stdio entry (index.ts)

**Work**

- Update `src/index.ts` to use `createPorts` factory
- Pass `getPorts` to `createServer`

**Acceptance criteria**

- `index.ts` uses factory, not direct PgliteBackend import
- stdio transport still works
- `npm run typecheck` passes

---

## Step 7 — Update tests

**Work**

- Existing tests in `pglite-backend.test.ts`, `auth.test.ts`, `tenant-isolation.test.ts`, and `integration.test.ts` should continue to test against `PgliteBackend` directly (they're adapter tests)
- Add a new test file `test/ports-interface.test.ts` that verifies:
  - `PgliteBackend` satisfies the `Ports` interface (compile-time check)
  - `createPorts` returns a valid `Ports` instance
  - Factory throws for unknown backend

**Acceptance criteria**

- All existing tests pass unchanged
- New interface test verifies type compliance
- Factory test covers happy path and error path
- `npm test` — all tests passing

---

## Step 8 — Clean up dead code and gaps

**Work**

- Remove unused `accountSetCachedJwks` method (jose handles JWKS caching)
- Remove unused `extractScopes` import in auth.ts if still present
- Remove unused `checkScope` function in server.ts if still present
- Add `backend` field to `render.yaml` env vars
- Update README with `HYPER_MCP_BACKEND` config option
- Add graceful shutdown that closes PGLite backend on SIGINT/SIGTERM/uncaughtException

**Acceptance criteria**

- No dead code warnings from TypeScript
- `render.yaml` includes `HYPER_MCP_BACKEND=pglite`
- README documents the backend config option
- Graceful shutdown verified in tests
- `npm run typecheck` passes
- `npm test` — all tests passing

---

## Step 9 — Update PRD and commit

**Work**

- Save this plan as `adapter-swap-plan.md` (already done)
- Create feature branch `feat/adapter-swap`
- Implement all steps
- Create PR with acceptance criteria

**Acceptance criteria**

- All steps 1-8 complete
- Feature branch pushed
- PR created with full test results
- `npm run typecheck` passes
- `npm run build` passes
- `npm test` — all tests passing

---

## Implementation Order

1. Define interfaces (types only, zero risk)
2. PgliteBackend implements Ports (typecheck catches gaps)
3. Refactor server.ts (biggest change, but mechanical)
4. Adapter factory (new code, isolated)
5. Refactor http.ts (wire factory in)
6. Refactor index.ts (small)
7. Add interface tests
8. Clean up
9. PR

## Risk Assessment

- **Low risk**: Steps 1, 2, 4, 7, 8 — additive or type-only changes
- **Medium risk**: Steps 3, 5, 6 — refactoring existing working code, but covered by 48 tests
- **No behavior changes**: The server, tools, auth, scopes, and tenant isolation work identically after refactoring
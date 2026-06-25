# hyper-mcp Hardening PRD

## Goal

Close the security, correctness, and contract-honesty gaps identified in
`docs/architecture-review.md` (2026-06-24) so `hyper-mcp` is safe to host and
ready for a second backend adapter. This is boundary hardening, not a rewrite —
the tool surface, port interfaces, and tenant model stay as-is.

## Relationship to prior plans

- `auth-prd.md` — **complete** (PR #1). Auth layer, account registry, scopes,
  tenant isolation all landed.
- `adapter-swap-plan.md` — **complete** (PR #2). Port interfaces, factory,
  server decoupled from `PgliteBackend`.
- This plan picks up where those left off, driven by the architecture review's
  P0/P1/P2 findings.

## Current baseline (2026-06-24)

- `npm run typecheck`: clean.
- `npm test`: 54/54 passing, 5 files. One unhandled rejection in
  `test/ports-interface.test.ts` (dangling `PgliteBackend` instance).
- Untracked: `context.md`, `docs/architecture-review.md`.

## Non-Goals

- Building the `scoutos` or `memory` adapter (deferred until a conformance
  suite exists and real pressure appears).
- Splitting the flat `Ports` interface into nested clients.
- Changing the MCP tool surface or scope mapping.
- Adding OAuth flows, user/password login, or an account dashboard UI.
- Production-grade full-text search or object storage — these get documented
  as MVP limits, not reimplemented in this plan.

## Implementation order and risk

| Step | Risk | Reason |
|---|---|---|
| 0. Baseline hygiene | Low | Docs + one test cleanup. |
| 1. Auth mode consistency | Medium | Touches security-critical path in `server.ts`; needs tests first. |
| 2. Issuer uniqueness | Low | Application-level check + test. |
| 3. Key/JWKS replacement | Medium | Changes `/register` semantics; needs explicit decision and tests. |
| 4. JWT + HTTP auth tests | Low (but enabling) | Pure test additions; unlocks confidence for steps 1–3. |
| 5. Contract honesty docs/config | Low | Docs + two hardcoded string fixes. |
| 6. `/metrics` and read-only posture | Low | Policy decision + small gates. |
| 7. Concurrency correctness | Medium | SQL changes to `cacheIncr` and queue offset allocation. |
| 8. Adapter conformance harness | Low | Test extraction; no runtime changes. |

Recommended sequencing: **0 → 4 → 1 → 2 → 3 → 5 → 6 → 7 → 8**. Land the test
harness (step 4) before the security changes (steps 1–3) so each change ships
with the tests that prove it.

---

## Step 0 — Baseline hygiene

### Work

- Commit `context.md` and `docs/architecture-review.md` to the repo.
- Fix the unhandled rejection in `test/ports-interface.test.ts`: the
  "PgliteBackend satisfies the Ports interface" test instantiates
  `new PgliteBackend(dir)` but never closes it. Close the instance in an
  `afterEach` (or refactor to use `createPorts` / `closePorts`).

### Acceptance criteria

- `context.md` and `docs/architecture-review.md` are tracked in git.
- `npm test` reports zero unhandled rejections.
- All 54 tests still pass.
- `npm run typecheck` passes.

---

## Step 1 — Auth mode consistency (P0-1)

### Problem

`src/server.ts:47` enforces scopes only when `config.authRequired && config.admin`
is true. With `authRequired=true` (default) but no admin trust root:

- HTTP `/mcp` returns `503 admin_not_configured` (correct, fails closed).
- stdio tools run unauthenticated as the `default` account (wrong, fails open).

Two transports with the same config produce different security boundaries.

### Work

- Make trust mode explicit. Add `HYPER_MCP_TRUST_MODE` with values:
  - `local` — local trusted mode; `authRequired` is effectively false; tools
    run as `default` account. Explicit opt-in for stdio / local dev.
  - `hosted` — auth required; tool handlers must have an auth context or fail
    with `AUTH_REQUIRED`. No silent default-account fallback.
- Default derivation: if `HYPER_MCP_TRUST_MODE` is unset, infer from
  `authRequired` + admin presence but emit a startup warning recommending
  explicit setting. Do not rely on inference long-term.
- In `server.ts`, change the scope-enforcement guard so that when trust mode
  is `hosted`, tool handlers fail closed without an auth context regardless of
  whether `config.admin` is set. The `admin` presence check belongs in the
  HTTP/stdio entrypoints (503), not in the tool handler.
- stdio entry (`src/index.ts`): if trust mode is `hosted` and no admin trust
  root is configured, refuse to start with a clear error rather than silently
  running unauthenticated.
- Document the mode in README and `render.yaml`.

### Acceptance criteria

- `HYPER_MCP_TRUST_MODE=hosted` with no admin trust root: stdio fails to start
  with a clear message; HTTP `/mcp` returns 503; no tool executes as
  `default`.
- `HYPER_MCP_TRUST_MODE=hosted` with admin configured but no auth context:
  every tool call returns `AUTH_REQUIRED` (401).
- `HYPER_MCP_TRUST_MODE=local`: tools run as `default` account without auth;
  documented as local-only.
- A test exercises all three branches (hosted + no admin → fail closed;
  hosted + admin + no context → AUTH_REQUIRED; local → default account).
- Existing 54 tests still pass.
- `npm run typecheck` passes.

---

## Step 2 — Account issuer uniqueness (P0-2)

### Problem

`accountGetByIssuer` returns the first active account row for an issuer. The
schema does not enforce unique active issuers, so two active accounts can share
an issuer, and JWTs for that issuer may authenticate against the wrong account.

### Work

- In `PgliteBackend.accountCreate`, reject creation of an active account whose
  `issuer` matches an existing active account's `issuer`. Use a unique
  partial index on `accounts(issuer) where status = 'active'` if PGLite
  supports it; otherwise enforce with an explicit lookup + test guard.
- Re-enabling a previously disabled account that collides with an active
  issuer must also be rejected.
- Return a clear `ISSUER_CONFLICT` error with status 409.
- `/unregister` frees the issuer for reuse (disabled accounts do not hold the
  unique constraint).

### Acceptance criteria

- Registering a second active account with an existing active issuer returns
  409 `ISSUER_CONFLICT` and does not create the row.
- After disabling the first account, the issuer can be registered again.
- Audit log records the failure attempt.
- A test covers: duplicate active issuer → 409; disabled issuer reusable;
  unique check does not block different issuers.
- Existing tests still pass.
- `npm run typecheck` passes.

---

## Step 3 — Key/JWKS replacement semantics (P0-3)

### Problem

`/register` accepts either `publicJwk` or `jwksUrl`. Re-registering an account
that switches auth mode can leave stale keys: if an account was registered with
an inline JWK and is later re-registered with a JWKS URL, the inline key may
still authenticate because auth prefers stored inline keys.

### Work

- Decide and implement one of:
  - **Option A (full replace):** `/register` always replaces auth material.
    On update, delete all existing `account_keys` and `account_jwks` rows for
    the account before inserting the new key or JWKS URL.
  - **Option B (explicit flag):** `/register` defaults to additive; switching
    auth mode requires `replaceAuth: true` in the request body. Without it,
    cross-mode updates return 409 `AUTH_MODE_CONFLICT`.
- Document the chosen behavior in README and `auth-prd.md` (append a
  "Replacement semantics" section).
- Add audit log entries for key/JWKS replacement.
- Existing single-mode re-registration (same key, refreshed) continues to work.

### Acceptance criteria

- The chosen option is documented and consistent across code, tests, and
  README.
- Re-registering from `publicJwk` to `jwksUrl` (per option's rules) results in
  the old inline key no longer authenticating the account.
- Re-registering from `jwksUrl` to `publicJwk` results in the JWKS URL no
  longer being consulted.
- A test covers both directions of mode switch and asserts the old material is
  inactive after replacement.
- Audit log records the replacement.
- Existing tests still pass.
- `npm run typecheck` passes.

---

## Step 4 — Real JWT + HTTP auth tests (P0-4)

### Problem

`test/auth.test.ts` covers the account store and scope helpers but not actual
JWT validation with signed Ed25519 tokens. There are no HTTP tests for
`/register`, `/unregister`, or `/mcp` authorization branches. The security
changes in steps 1–3 need this guardrail.

### Work

- Add `test/jwt-auth.test.ts`:
  - Generate an Ed25519 keypair in-test with `jose`.
  - Sign admin JWTs and call `validateAdminJwt` directly: valid token passes;
    missing `accounts:admin` → 403; expired → 401; wrong issuer → 401; wrong
    audience → 401; unknown `kid` → 401.
  - Sign account JWTs and call `validateAccountJwt` against a registered
    account: valid token passes; disabled account → 401/403; wrong issuer →
    401; scopes come from the DB record, not the JWT payload.
  - JWKS URL path: stub a fetch returning a JWKS, verify cache TTL behavior.
- Add `test/http-routes.test.ts`:
  - Spin up the HTTP app against a temp PGLite dir.
  - `GET /` and `GET /health` work unauthenticated.
  - `POST /mcp` without token → 401 (hosted mode).
  - `POST /register` without admin trust root → 503.
  - `POST /register` with valid admin JWT → 201; with non-admin JWT → 403;
    with expired admin JWT → 401; missing `publicJwk`/`jwksUrl` → 400.
  - `POST /unregister` without `confirm: true` → 400; on unknown account →
    404; on valid account → 200 with `status: disabled`.
  - Registered account JWT calling `/mcp` reaches the MCP transport and can
    call a read tool; disabled account JWT is rejected.
  - Scope enforcement: read-only account calling a write tool → 403.

### Acceptance criteria

- Both new test files run as part of `npm test`.
- Every branch listed above has a passing assertion.
- Tests use real signed JWTs (no mocked signatures).
- No new unhandled rejections.
- Total test count increases; existing 54 tests still pass.
- `npm run typecheck` passes.

---

## Step 5 — Contract honesty: docs and config drift (P1)

### Problem

- `src/server.ts:31` hardcodes `backend: "pglite"` in the `scoutos://ports`
  resource. `src/http.ts` health reports `pglite` rather than `config.backend`.
- README test count is stale.
- README says cache has "atomic counters"; implementation is read-then-write.
- README implies `data_create_index` creates real indexes; it records metadata.
- Blob signing returns `pglite://` pseudo URLs presented as signed URLs.
- Queue and search semantics are described stronger than the MVP delivers.
- stdio/default-account behavior is not documented.

### Work

- Replace hardcoded `"pglite"` with `config.backend` in the `scoutos://ports`
  resource and in the `/health` response.
- Update README:
  - Endpoint table includes `/metrics`.
  - Test count matches actual.
  - Cache: change "atomic counters" to "counter helpers (not atomic under
    concurrency)".
  - Data index: state that `data_create_index` records compatibility metadata,
    not operational indexes.
  - Blob signing: state that `blob_sign` returns `pglite://` pseudo URLs for
    MVP, not externally usable signed URLs.
  - Queue: describe as lightweight MVP; not Kafka-grade; partitions partial.
  - Search: describe as simple contains/match/term query; no scoring or real
    full-text index.
  - stdio: document the trust-mode behavior from step 1.
- Add a `docs/port-contracts.md` page distinguishing compatibility behavior
  from production guarantees per port.

### Acceptance criteria

- `/health` and `scoutos://ports` report `config.backend`, not a hardcoded
  string. A test asserts the health response uses `config.backend`.
- README test count matches `npm test` output.
- README no longer claims atomic counters, real indexes, or real signed URLs.
- `docs/port-contracts.md` exists and covers all five ports.
- Existing tests still pass.
- `npm run typecheck` passes.

---

## Step 6 — `/metrics` and read-only posture (P1)

### Problem

- `/metrics` is unauthenticated and exposes request/tool/auth-failure counters.
  No policy decision is documented.
- `HYPER_MCP_READONLY` gates MCP tool writes but not `/register` or
  `/unregister`, so admin mutations still succeed in read-only mode.

### Work

- `/metrics` policy: add `HYPER_MCP_METRICS_PUBLIC` (default `true` for
  backwards compatibility). When false, require admin JWT. Document the
  default and the recommendation to disable on public deployments.
- Read-only policy: decide and implement "read-only = data-plane only" (admin
  routes still mutate) vs "read-only = entire service". Recommended:
  read-only blocks admin mutations too, with a clear
  `READ_ONLY_ADMIN_BLOCKED` response. Document the decision.
- Add tests for both.

### Acceptance criteria

- `HYPER_MCP_METRICS_PUBLIC=false` makes `/metrics` require admin JWT; without
  it returns 401. Default (`true`) preserves current behavior.
- With `HYPER_MCP_READONLY=true`, `/register` and `/unregister` are blocked
  (per the chosen policy) and return a clear error. Documented in README.
- Tests cover both configs.
- Existing tests still pass.
- `npm run typecheck` passes.

---

## Step 7 — Concurrency correctness (P1)

### Problem

- `cacheIncr` is read-then-write (`src/pglite-backend.ts:279-287`); concurrent
  increments lose updates.
- `queuePublish` computes `max(offset)+1` then inserts
  (`src/pglite-backend.ts:348-355`); concurrent publishers can collide offsets.

### Work

- `cacheIncr` / `cacheDecr`: use a single SQL `UPDATE ... SET value = value +
  $by RETURNING value` inside a transaction. Preserve TTL semantics: if the
  key has a TTL, the increment must not reset it; if the key is missing,
  behavior is defined (create with `by` vs. error — pick one and document it).
- `queuePublish`: allocate offsets atomically. Use a Postgres sequence per
  topic, or `INSERT ... RETURNING` with a `COALESCE(max+offset, 0)` wrapped in
  a transaction with `SELECT ... FOR UPDATE` on the topic row, or a dedicated
  `queue_topic_offsets` table updated atomically.
- Add concurrency tests: fire N parallel `cache_incr` calls on the same key
  and assert the final value equals N (within tolerance for the chosen
  semantics). Fire N parallel `queue_publish` calls and assert offsets are
  unique and contiguous.

### Acceptance criteria

- `cacheIncr` under 50 concurrent calls produces the expected final value with
  no lost updates. TTL is preserved across increments.
- `queuePublish` under 50 concurrent calls produces 50 unique, contiguous
  offsets with no collisions.
- README counter/queue language matches the new behavior (update from step 5
  if needed).
- Existing tests still pass.
- `npm run typecheck` passes.

---

## Step 8 — Adapter conformance harness (P2)

### Problem

The `Ports` interface is the right seam, but there is no shared test suite that
a future `scoutos` or `memory` adapter must pass. Today every adapter would
have to be re-validated by hand.

### Work

- Extract the port-behavior assertions from `test/pglite-backend.test.ts` and
  `test/tenant-isolation.test.ts` into a reusable
  `test/conformance/ports.conformance.ts` that takes a `() => Promise<Ports>`
  factory and runs the full data/cache/blob/queue/search + tenant-isolation
  suite against it.
- Run the conformance suite against `PgliteBackend` in
  `test/conformance/pglite.test.ts` (a thin wrapper that supplies the factory).
- Do not build new adapters. The harness is the deliverable.

### Acceptance criteria

- `test/conformance/ports.conformance.ts` exports a function that runs the
  full port + tenant-isolation suite against any `Ports` factory.
- `test/conformance/pglite.test.ts` passes by delegating to the harness.
- The original `pglite-backend.test.ts` and `tenant-isolation.test.ts` either
  delegate to the harness or remain as adapter-specific tests alongside it —
  no behavior coverage is lost.
- `npm test` passes; total count does not drop.
- A comment at the top of the harness documents how a future adapter wires in.
- `npm run typecheck` passes.

---

## Definition of done (whole plan)

- All steps 0–8 complete and merged.
- `npm run typecheck`, `npm run build`, and `npm test` all pass cleanly with
  zero unhandled rejections.
- README, `docs/port-contracts.md`, and `docs/architecture-review.md` reflect
  current behavior.
- No tool can execute as the `default` account under hosted mode without an
  auth context.
- No duplicate active issuer can exist.
- Auth material replacement has defined, tested semantics.
- `/metrics`, read-only, and concurrency behavior are documented and tested.
- A conformance harness exists for future adapters.

## Out of scope (explicitly deferred)

- `scoutos` and `memory` adapter implementations.
- Splitting `Ports` into nested `DataPorts` / `ControlPorts`.
- Real full-text search, real object storage, real index execution.
- OAuth, user/password login, account dashboard UI.
- Multi-instance horizontal scaling (single-process PGLite assumption remains).
# research-plan-loop handoff — baas-adapter

- 2026-06-27T12:36 begin — task: BaaS adapter contract (IdentityResolver + FunctionRuntime + user-scoped data/RLS + dynamic /u/:acct/:fn endpoints). Prototype impls (PGLite + sandbox runtime + opaque tokens); prod impls (external Postgres + Daytona + OIDC) swappable. Slug: baas-adapter. Branch: feat/baas-adapter.
- 2026-06-27T12:39 research-done — PGLite does NOT enforce RLS policies (prototype must enforce user-scoping in app code via ctx.db wrapper; prod external Postgres uses engine RLS). FunctionRuntime prototype = node:vm restricted context (trusted dev code); prod = Daytona. quickjs-emscripten API too fiddly for this cycle; removed.
- 2026-06-27T12:40 plan-approved — PRD + progress HTML; plan-review gate passed (manual). Implementing steps 1-8 (prototype impls; prod adapters contract-only).
- 2026-06-27T12:47 step-1..8-done — BaaS adapter prototype impls complete. typecheck+build+test 174/174 green.
- 2026-06-27T12:47 complete — BaaS adapter (IdentityResolver + FunctionRuntime + user-scoped data/RLS + /u/:acct/:fn) prototype impls shipped on feat/baas-adapter. Prod adapters (external Postgres RLS, Daytona, OIDC) contract-only. Status: complete.

#!/usr/bin/env tsx
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { SignJWT, exportJWK, generateKeyPair, importJWK } from "jose";

type Args = {
  baseUrl: string;
  accountId: string;
  out: string;
  generateOnly: boolean;
  timeoutMs: number;
};

type KeyMaterial = {
  kid: string;
  issuer: string;
  audience: string;
  privateKey: CryptoKey | Uint8Array;
  publicJwk: Record<string, unknown>;
};

const DEMO_AUTH = `async (ctx) => {
  const raw = ctx.body && ctx.body.readerId ? String(ctx.body.readerId) : "reader";
  const readerId = raw.replace(/[^a-zA-Z0-9_.-]/g, "").slice(0, 64) || "reader";
  const email = "demo-" + readerId + "@zenbin-blog-demo.invalid";
  const found = await ctx.auth.findUsers({ email });
  let userId = found.users[0] && found.users[0].userId;
  if (!userId) {
    const created = await ctx.auth.createUser({ email, attributes: { demo: "zenbin-baas-blog", readerId } });
    userId = created.userId;
  }
  const session = await ctx.auth.createSession(userId, { ttlSeconds: 86400 });
  return { userId, email, token: session.token, expiresAt: session.expiresAt };
}`;

const ENSURE_BLOG_POSTS = `async (ctx) => {
  const seed = [
    { slug: "launch-notes", title: "Launch notes from a tiny backend", dek: "A static page, a BaaS function, and a few rows of PGLite walk into a demo.", author: "Mira Chen", tag: "release", readingMinutes: 3, createdAt: "2026-06-30T10:00:00.000Z", body: "The point is not the blog. The point is that the page has no backend of its own. It asks hyper-mcp for a reader session, then reads user-scoped documents through ctx.db." },
    { slug: "rls-by-convention", title: "User-scoped data without a database client in the browser", dek: "The browser never sees account credentials; it only gets a short-lived reader token.", author: "Noah Vale", tag: "security", readingMinutes: 4, createdAt: "2026-06-29T15:30:00.000Z", body: "Every db call in the function context carries the resolved user id. The demo keeps posts per reader, which makes the isolation visible and easy to reset." },
    { slug: "zenbin-shell", title: "Why host the shell on ZenBin?", dek: "ZenBin signs and gates the artifact; hyper-mcp stores the changing app data.", author: "Ada Park", tag: "architecture", readingMinutes: 2, createdAt: "2026-06-28T18:10:00.000Z", body: "This split is useful for demos and small tools: publish a private static shell, then let BaaS functions handle identity, data, and mutations." },
    { slug: "next-steps", title: "What would make this production-grade", dek: "Real OIDC, a sandbox runtime, and a database-enforced RLS adapter are the next line items.", author: "Sam Rivera", tag: "roadmap", readingMinutes: 5, createdAt: "2026-06-27T08:45:00.000Z", body: "The current VM runtime is for trusted account-authored functions. Production multi-tenant code should use the Daytona runtime and engine-enforced Postgres RLS." }
  ];
  const count = await ctx.db.count("blogPosts");
  let seeded = false;
  if (count.count === 0) {
    for (const post of seed) await ctx.db.create("blogPosts", post);
    seeded = true;
  }
  const found = await ctx.db.find("blogPosts", { limit: 50 });
  const posts = found.documents.sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)));
  return { seeded, total: found.total, posts };
}`;

const LIST_BLOG_POSTS = `async (ctx) => {
  const found = await ctx.db.find("blogPosts", { limit: 50 });
  const posts = found.documents.sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)));
  return { total: found.total, posts, user: ctx.user };
}`;

function parseArgs(argv: string[]): Args {
  const args: Args = {
    baseUrl: normalizeBaseUrl(process.env.HYPER_MCP_DEMO_BASE_URL || "https://hyper-mcp.onrender.com"),
    accountId: process.env.HYPER_MCP_DEMO_ACCOUNT_ID || "zenbin-blog-demo",
    out: process.env.HYPER_MCP_DEMO_OUT || "dist/zenbin-blog-demo.html",
    generateOnly: false,
    timeoutMs: Number(process.env.HYPER_MCP_DEMO_TIMEOUT_MS || 30_000),
  };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--base-url") args.baseUrl = normalizeBaseUrl(required(argv, ++i, arg));
    else if (arg === "--account-id") args.accountId = required(argv, ++i, arg);
    else if (arg === "--out") args.out = required(argv, ++i, arg);
    else if (arg === "--generate-only") args.generateOnly = true;
    else if (arg === "--timeout-ms") args.timeoutMs = Number(required(argv, ++i, arg));
    else if (arg === "--help" || arg === "-h") { printHelp(); process.exit(0); }
    else throw new Error(`unknown arg: ${arg}`);
  }
  if (!Number.isFinite(args.timeoutMs) || args.timeoutMs <= 0) throw new Error("--timeout-ms must be positive");
  return args;
}

function required(argv: string[], i: number, flag: string) {
  const value = argv[i];
  if (!value) throw new Error(`${flag} requires a value`);
  return value;
}

function normalizeBaseUrl(input: string) {
  const value = input.trim();
  if (!value) throw new Error("base URL is required");
  const withScheme = /^https?:\/\//i.test(value) ? value : `https://${value}`;
  return withScheme.replace(/\/+$/, "");
}

function printHelp() {
  console.log(`ZenBin + hyper-mcp BaaS blog demo\n\nUsage:\n  npx tsx scripts/zenbin-blog-demo.ts --generate-only\n  npx tsx scripts/zenbin-blog-demo.ts --base-url https://hyper-mcp.onrender.com\n\nOptions:\n  --base-url <url>      hyper-mcp service, default https://hyper-mcp.onrender.com\n  --account-id <id>     BaaS account id, default zenbin-blog-demo\n  --out <file>          generated HTML path, default dist/zenbin-blog-demo.html\n  --generate-only       skip remote account/function provisioning\n  --timeout-ms <ms>     MCP request timeout, default 30000\n\nProvisioning env (not needed for --generate-only):\n  HYPER_MCP_ADMIN_PRIVATE_JWK   admin private JWK JSON matching service trust root\n  HYPER_MCP_ADMIN_ISSUER        default admin-agent\n  HYPER_MCP_ADMIN_AUDIENCE      default hyper-mcp\n  HYPER_MCP_ADMIN_KID           default admin-1\n  HYPER_MCP_DEMO_ACCOUNT_PRIVATE_JWK optional persistent account private JWK JSON\n`);
}

async function importPrivateJwk(json: string, kid: string, issuer: string, audience: string): Promise<KeyMaterial> {
  const jwk = JSON.parse(json);
  const privateKey = await importJWK(jwk, "EdDSA");
  const exported = await exportJWK(privateKey);
  return { kid, issuer, audience, privateKey: privateKey as CryptoKey, publicJwk: { kty: exported.kty, crv: exported.crv, x: exported.x, kid } };
}

async function generatedKey(kid: string, issuer: string, audience: string): Promise<KeyMaterial> {
  const pair = await generateKeyPair("Ed25519", { extractable: true });
  return { kid, issuer, audience, privateKey: pair.privateKey as CryptoKey, publicJwk: { ...(await exportJWK(pair.publicKey)), kid } };
}

async function sign(km: KeyMaterial, claims: Record<string, unknown> = {}) {
  return new SignJWT(claims)
    .setProtectedHeader({ alg: "EdDSA", kid: km.kid })
    .setIssuer(km.issuer)
    .setAudience(km.audience)
    .setExpirationTime("1h")
    .sign(km.privateKey);
}

async function registerAccount(baseUrl: string, admin: KeyMaterial, account: KeyMaterial, accountId: string) {
  const res = await fetch(`${baseUrl}/register`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${await sign(admin, { scope: "accounts:admin" })}` },
    body: JSON.stringify({
      accountId,
      name: "ZenBin blog demo",
      issuer: account.issuer,
      audience: account.audience,
      publicJwk: account.publicJwk,
      ports: { "app:read": true, "app:write": true },
    }),
  });
  const text = await res.text();
  if (res.status === 503) throw new Error(`remote admin trust is not configured on ${baseUrl} (/register returned 503): ${text.slice(0, 240)}`);
  if (res.status !== 201) throw new Error(`/register failed (${res.status}): ${text.slice(0, 1000)}`);
}

async function makeClient(baseUrl: string, account: KeyMaterial, timeoutMs: number) {
  const token = await sign(account);
  const transport = new StreamableHTTPClientTransport(new URL(`${baseUrl}/mcp`), {
    requestInit: { headers: { authorization: `Bearer ${token}` } },
  });
  const client = new Client({ name: "zenbin-blog-demo", version: "0.1.0" }, { capabilities: {} });
  await client.connect(transport, { timeout: timeoutMs });
  return client;
}

async function callTool(client: Client, name: string, args: Record<string, unknown>) {
  const res = await client.callTool({ name, arguments: args });
  const text = (res.content as any)[0]?.text || "{}";
  if (res.isError) throw new Error(`${name} failed: ${text}`);
  return JSON.parse(text);
}

async function provision(args: Args) {
  const adminJson = process.env.HYPER_MCP_ADMIN_PRIVATE_JWK;
  if (!adminJson) throw new Error("HYPER_MCP_ADMIN_PRIVATE_JWK is required to provision the remote demo. Re-run with --generate-only to only write the HTML.");
  const admin = await importPrivateJwk(
    adminJson,
    process.env.HYPER_MCP_ADMIN_KID || "admin-1",
    process.env.HYPER_MCP_ADMIN_ISSUER || "admin-agent",
    process.env.HYPER_MCP_ADMIN_AUDIENCE || "hyper-mcp",
  );
  const account = process.env.HYPER_MCP_DEMO_ACCOUNT_PRIVATE_JWK
    ? await importPrivateJwk(process.env.HYPER_MCP_DEMO_ACCOUNT_PRIVATE_JWK, process.env.HYPER_MCP_DEMO_ACCOUNT_KID || "zenbin-blog-demo-1", args.accountId, "hyper-mcp")
    : await generatedKey(process.env.HYPER_MCP_DEMO_ACCOUNT_KID || "zenbin-blog-demo-1", args.accountId, "hyper-mcp");

  await registerAccount(args.baseUrl, admin, account, args.accountId);
  const client = await makeClient(args.baseUrl, account, args.timeoutMs);
  try {
    await callTool(client, "app_register_function", { name: "demoAuth", public: true, body: DEMO_AUTH });
    await callTool(client, "app_register_function", { name: "ensureBlogPosts", public: false, body: ENSURE_BLOG_POSTS });
    await callTool(client, "app_register_function", { name: "listBlogPosts", public: false, body: LIST_BLOG_POSTS });
  } finally {
    await client.close().catch(() => undefined);
  }
}

function escapeHtml(value: string) {
  return value.replace(/[&<>"]/g, (ch) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[ch]!));
}

function jsString(value: string) {
  return JSON.stringify(value).replace(/</g, "\\u003c");
}

function renderHtml(args: Args) {
  const title = "Private Hyper-MCP Blog";
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>${escapeHtml(title)}</title>
<style>
:root{color-scheme:dark;--bg:#0d1117;--card:#151b24;--ink:#eef5ff;--muted:#96a4b8;--line:#283243;--accent:#8ee6cf;--accent2:#b89cff;--bad:#ff8b8b}*{box-sizing:border-box}body{margin:0;font:15px/1.5 ui-sans-serif,system-ui,-apple-system,Segoe UI,sans-serif;background:radial-gradient(circle at top left,#243045 0,#0d1117 34rem),var(--bg);color:var(--ink)}main{max-width:1060px;margin:0 auto;padding:42px 20px 64px}.hero{display:grid;gap:18px;margin-bottom:28px}.eyebrow{color:var(--accent);font:12px/1.2 ui-monospace,SFMono-Regular,Menlo,monospace;letter-spacing:.12em;text-transform:uppercase}h1{font-size:clamp(34px,7vw,78px);line-height:.94;letter-spacing:-.06em;margin:0;max-width:880px}.lede{max-width:720px;color:var(--muted);font-size:18px}.panel{background:linear-gradient(180deg,rgba(255,255,255,.055),rgba(255,255,255,.025));border:1px solid var(--line);border-radius:24px;padding:20px;box-shadow:0 24px 70px rgba(0,0,0,.28)}.toolbar{display:flex;flex-wrap:wrap;gap:12px;align-items:center;justify-content:space-between;margin-bottom:18px}.status{font-family:ui-monospace,SFMono-Regular,Menlo,monospace;color:var(--muted);font-size:13px}.status strong{color:var(--accent)}button{border:0;border-radius:999px;padding:11px 16px;background:var(--accent);color:#08231d;font-weight:750;cursor:pointer}button.secondary{background:#222b39;color:var(--ink);border:1px solid var(--line)}button:disabled{opacity:.55;cursor:wait}.grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(240px,1fr));gap:14px}.post{background:var(--card);border:1px solid var(--line);border-radius:20px;padding:18px;min-height:240px;display:flex;flex-direction:column;gap:10px}.tag{align-self:flex-start;border:1px solid rgba(142,230,207,.4);color:var(--accent);border-radius:999px;padding:3px 9px;font-size:12px}.post h2{margin:0;font-size:22px;letter-spacing:-.02em}.dek{color:#c5d0df}.meta{margin-top:auto;color:var(--muted);font-size:13px}.body{color:#d8e2f0}.error{border-color:rgba(255,139,139,.5);color:var(--bad)}code{background:#111824;border:1px solid var(--line);border-radius:6px;padding:2px 5px}.foot{margin-top:20px;color:var(--muted);font-size:13px}a{color:var(--accent2)}
</style>
</head>
<body>
<main>
  <section class="hero">
    <div class="eyebrow">ZenBin sign-to-read shell + hyper-mcp BaaS</div>
    <h1>Fake blog posts from a real user-scoped data store.</h1>
    <p class="lede">This private page is static HTML. It asks hyper-mcp for a demo reader session, seeds a few posts through an authenticated BaaS function, then fetches them from <code>ctx.db</code>. No admin JWT, account JWT, or private key is shipped to the browser.</p>
  </section>

  <section class="panel">
    <div class="toolbar">
      <div class="status" id="status">Idle. Service: <strong>${escapeHtml(args.baseUrl)}</strong> · account <strong>${escapeHtml(args.accountId)}</strong></div>
      <div>
        <button id="load">Connect + fetch posts</button>
        <button class="secondary" id="reset">Reset local reader</button>
      </div>
    </div>
    <div class="grid" id="posts"></div>
    <p class="foot">If this fails in a browser, check that the hyper-mcp deployment has BaaS CORS enabled and that the demo functions are provisioned for <code>${escapeHtml(args.accountId)}</code>.</p>
  </section>
</main>
<script>
const BASE_URL = ${jsString(args.baseUrl)};
const ACCOUNT_ID = ${jsString(args.accountId)};
const storage = {
  reader: 'hyper-mcp-blog-demo:reader:' + ACCOUNT_ID,
  token: 'hyper-mcp-blog-demo:token:' + ACCOUNT_ID
};
const el = {
  status: document.getElementById('status'),
  posts: document.getElementById('posts'),
  load: document.getElementById('load'),
  reset: document.getElementById('reset')
};
function setStatus(text, ok = true) { el.status.innerHTML = ok ? text : '<span class="error">' + escapeText(text) + '</span>'; }
function escapeText(value) { return String(value).replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c])); }
function readerId() {
  let id = localStorage.getItem(storage.reader);
  if (!id) {
    id = (crypto.randomUUID ? crypto.randomUUID() : String(Date.now()) + Math.random().toString(16).slice(2)).replace(/[^a-zA-Z0-9_.-]/g, '').slice(0, 48);
    localStorage.setItem(storage.reader, id);
  }
  return id;
}
async function call(fn, body = {}, token) {
  const headers = { 'content-type': 'application/json' };
  if (token) headers.authorization = 'Bearer ' + token;
  const res = await fetch(BASE_URL + '/u/' + encodeURIComponent(ACCOUNT_ID) + '/' + encodeURIComponent(fn), { method: 'POST', headers, body: JSON.stringify(body) });
  const text = await res.text();
  let json;
  try { json = JSON.parse(text); } catch { throw new Error('Non-JSON response from ' + fn + ': ' + text.slice(0, 180)); }
  if (!res.ok || !json.ok) throw new Error((json.error || fn + ' failed') + ': ' + (json.message || text.slice(0, 180)));
  return json.result;
}
function render(posts) {
  el.posts.innerHTML = posts.map(post => '<article class="post">' +
    '<span class="tag">' + escapeText(post.tag || 'post') + '</span>' +
    '<h2>' + escapeText(post.title) + '</h2>' +
    '<p class="dek">' + escapeText(post.dek) + '</p>' +
    '<p class="body">' + escapeText(post.body) + '</p>' +
    '<div class="meta">' + escapeText(post.author || 'demo') + ' · ' + escapeText(post.readingMinutes || '?') + ' min · ' + escapeText((post.createdAt || '').slice(0, 10)) + '</div>' +
  '</article>').join('');
}
async function load() {
  el.load.disabled = true;
  try {
    setStatus('Creating demo reader session…');
    const auth = await call('demoAuth', { readerId: readerId() });
    localStorage.setItem(storage.token, auth.token);
    setStatus('Seeding user-scoped posts through <strong>ensureBlogPosts</strong>…');
    await call('ensureBlogPosts', {}, auth.token);
    setStatus('Fetching posts through <strong>listBlogPosts</strong>…');
    const result = await call('listBlogPosts', {}, auth.token);
    render(result.posts || []);
    setStatus('Loaded <strong>' + (result.posts || []).length + '</strong> posts for reader <strong>' + escapeText(auth.email) + '</strong>.');
  } catch (error) {
    console.error(error);
    setStatus(error.message || String(error), false);
  } finally {
    el.load.disabled = false;
  }
}
el.load.addEventListener('click', load);
el.reset.addEventListener('click', () => { localStorage.removeItem(storage.reader); localStorage.removeItem(storage.token); el.posts.innerHTML = ''; setStatus('Local reader reset. Click connect to create a fresh user-scoped store.'); });
load();
</script>
</body>
</html>`;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (!args.generateOnly) await provision(args);
  const html = renderHtml(args);
  const out = resolve(args.out);
  await mkdir(dirname(out), { recursive: true });
  await writeFile(out, html, "utf8");
  console.log(`Wrote ${out}`);
  if (args.generateOnly) console.log("Skipped remote provisioning (--generate-only).");
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});

export function landingPage() {
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>hyper-mcp — ScoutOS ports for agents</title>
  <meta name="description" content="hyper-mcp exposes ScoutOS-style data, cache, blob, queue, and search ports to AI agents over MCP, backed by persistent PGLite." />
  <style>
    :root {
      --ink: #12100c;
      --muted: #635b4b;
      --paper: #f5eddb;
      --paper-2: #eadfc8;
      --line: rgba(18, 16, 12, .18);
      --hot: #ff4b1f;
      --green: #1f8f5f;
      --blue: #2457ff;
      --violet: #6b36d8;
      --shadow: 0 28px 80px rgba(34, 24, 12, .22);
      --mono: "Berkeley Mono", "SFMono-Regular", "Cascadia Code", "Liberation Mono", monospace;
      --serif: "Iowan Old Style", "Palatino", "Book Antiqua", Georgia, serif;
      --sans: "Avenir Next", "Gill Sans", "Trebuchet MS", sans-serif;
    }

    * { box-sizing: border-box; }
    html { scroll-behavior: smooth; }
    body {
      margin: 0;
      color: var(--ink);
      background:
        radial-gradient(circle at 12% 8%, rgba(255, 75, 31, .28), transparent 26rem),
        radial-gradient(circle at 86% 18%, rgba(36, 87, 255, .20), transparent 24rem),
        linear-gradient(135deg, var(--paper), #fbf7ec 45%, var(--paper-2));
      font-family: var(--sans);
      min-height: 100vh;
      overflow-x: hidden;
    }

    body::before {
      content: "";
      position: fixed;
      inset: 0;
      pointer-events: none;
      opacity: .45;
      background-image:
        linear-gradient(rgba(18,16,12,.045) 1px, transparent 1px),
        linear-gradient(90deg, rgba(18,16,12,.045) 1px, transparent 1px),
        radial-gradient(rgba(18,16,12,.14) .8px, transparent .8px);
      background-size: 52px 52px, 52px 52px, 7px 7px;
      mix-blend-mode: multiply;
    }

    a { color: inherit; }
    .wrap { width: min(1180px, calc(100vw - 36px)); margin: 0 auto; }

    nav {
      position: sticky;
      top: 0;
      z-index: 10;
      backdrop-filter: blur(16px);
      background: rgba(245, 237, 219, .78);
      border-bottom: 1px solid var(--line);
    }
    .nav-inner {
      height: 64px;
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 20px;
      font-family: var(--mono);
      font-size: 12px;
      letter-spacing: .04em;
      text-transform: uppercase;
    }
    .brand { display: flex; align-items: center; gap: 10px; font-weight: 800; }
    .mark {
      width: 28px; height: 28px;
      border: 2px solid var(--ink);
      transform: rotate(-7deg);
      background: conic-gradient(from 90deg, var(--hot), #ffd166, var(--green), var(--blue), var(--hot));
      box-shadow: 4px 4px 0 var(--ink);
    }
    .nav-links { display: flex; gap: 18px; color: var(--muted); }
    .nav-links a { text-decoration: none; }
    .nav-links a:hover { color: var(--ink); }

    header {
      position: relative;
      padding: 84px 0 52px;
    }
    .hero {
      display: grid;
      grid-template-columns: 1.05fr .95fr;
      gap: 44px;
      align-items: center;
    }
    .eyebrow {
      display: inline-flex;
      align-items: center;
      gap: 10px;
      padding: 8px 12px;
      border: 1px solid var(--line);
      border-radius: 999px;
      background: rgba(255,255,255,.34);
      font: 700 12px/1 var(--mono);
      text-transform: uppercase;
      letter-spacing: .08em;
      color: var(--muted);
    }
    .pulse {
      width: 9px; height: 9px;
      background: var(--green);
      border-radius: 999px;
      box-shadow: 0 0 0 0 rgba(31,143,95,.65);
      animation: pulse 1.8s infinite;
    }
    @keyframes pulse { 70% { box-shadow: 0 0 0 12px rgba(31,143,95,0); } }

    h1 {
      margin: 26px 0 18px;
      font-family: var(--serif);
      font-size: clamp(58px, 9vw, 132px);
      line-height: .83;
      letter-spacing: -.075em;
      max-width: 820px;
    }
    h1 em {
      font-style: normal;
      color: var(--hot);
      text-shadow: 3px 3px 0 rgba(18,16,12,.13);
    }
    .lede {
      max-width: 720px;
      font-size: clamp(18px, 2.1vw, 25px);
      line-height: 1.35;
      color: #3d382e;
    }
    .lede strong { color: var(--ink); }
    .actions { display: flex; flex-wrap: wrap; gap: 14px; margin-top: 30px; }
    .btn {
      display: inline-flex;
      align-items: center;
      gap: 10px;
      min-height: 48px;
      padding: 13px 18px;
      border: 2px solid var(--ink);
      border-radius: 14px;
      background: var(--ink);
      color: var(--paper);
      text-decoration: none;
      font: 800 13px/1 var(--mono);
      letter-spacing: .02em;
      box-shadow: 7px 7px 0 rgba(18,16,12,.18);
      transition: transform .16s ease, box-shadow .16s ease;
    }
    .btn.secondary { background: transparent; color: var(--ink); }
    .btn:hover { transform: translate(-2px, -2px); box-shadow: 10px 10px 0 rgba(18,16,12,.18); }

    .machine {
      position: relative;
      min-height: 560px;
      border: 2px solid var(--ink);
      border-radius: 28px;
      background: rgba(255,255,255,.42);
      box-shadow: var(--shadow), 12px 12px 0 rgba(18,16,12,.10);
      overflow: hidden;
      transform: rotate(1.2deg);
    }
    .machine::before {
      content: "PERSISTENT PGLITE CORE";
      display: block;
      padding: 14px 18px;
      border-bottom: 2px solid var(--ink);
      background: var(--ink);
      color: var(--paper);
      font: 800 12px/1 var(--mono);
      letter-spacing: .09em;
    }
    .diagram {
      position: absolute;
      inset: 72px 28px 28px;
      display: grid;
      place-items: center;
    }
    .core {
      width: 190px;
      height: 190px;
      display: grid;
      place-items: center;
      border: 2px solid var(--ink);
      border-radius: 50%;
      background: radial-gradient(circle, #fff7d7, #ffc857 68%, #ff9f1c);
      font: 900 18px/1.1 var(--mono);
      text-align: center;
      box-shadow: 0 0 0 16px rgba(255,200,87,.22), 8px 8px 0 rgba(18,16,12,.18);
      animation: float 5s ease-in-out infinite;
    }
    @keyframes float { 50% { transform: translateY(-9px); } }
    .node {
      position: absolute;
      width: 132px;
      padding: 14px 12px;
      border: 2px solid var(--ink);
      border-radius: 18px;
      background: var(--paper);
      box-shadow: 6px 6px 0 rgba(18,16,12,.14);
      font-family: var(--mono);
      font-size: 12px;
      font-weight: 900;
      text-align: center;
      text-transform: uppercase;
    }
    .node small { display: block; margin-top: 6px; color: var(--muted); font-weight: 700; text-transform: none; }
    .n-data { top: 6px; left: 50%; transform: translateX(-50%); border-color: var(--blue); }
    .n-cache { top: 150px; right: 0; border-color: var(--green); }
    .n-blob { bottom: 18px; right: 50px; border-color: var(--hot); }
    .n-queue { bottom: 18px; left: 50px; border-color: var(--violet); }
    .n-search { top: 150px; left: 0; border-color: #b7791f; }

    .rail {
      margin-top: 34px;
      display: grid;
      grid-template-columns: repeat(4, 1fr);
      border: 2px solid var(--ink);
      border-radius: 22px;
      overflow: hidden;
      box-shadow: 8px 8px 0 rgba(18,16,12,.12);
      background: rgba(255,255,255,.35);
    }
    .stat { padding: 18px; border-right: 1px solid var(--line); }
    .stat:last-child { border-right: 0; }
    .stat b { display: block; font: 900 28px/1 var(--serif); }
    .stat span { display: block; margin-top: 5px; color: var(--muted); font: 700 11px/1.2 var(--mono); text-transform: uppercase; }

    section { padding: 62px 0; }
    .section-head {
      display: grid;
      grid-template-columns: .8fr 1.2fr;
      gap: 28px;
      align-items: end;
      margin-bottom: 26px;
    }
    h2 {
      margin: 0;
      font-family: var(--serif);
      font-size: clamp(42px, 6vw, 84px);
      line-height: .9;
      letter-spacing: -.055em;
    }
    .section-head p { margin: 0; color: var(--muted); font-size: 18px; line-height: 1.45; }

    .ports {
      display: grid;
      grid-template-columns: repeat(5, minmax(0, 1fr));
      gap: 14px;
    }
    .port-card {
      position: relative;
      min-height: 310px;
      padding: 20px;
      border: 2px solid var(--ink);
      border-radius: 26px;
      background: rgba(255,255,255,.45);
      box-shadow: 7px 7px 0 rgba(18,16,12,.11);
      overflow: hidden;
    }
    .port-card::after {
      content: "";
      position: absolute;
      right: -24px;
      top: -24px;
      width: 86px;
      height: 86px;
      border-radius: 50%;
      background: var(--accent);
      opacity: .22;
    }
    .port-card h3 { margin: 0; font: 900 22px/1 var(--mono); text-transform: uppercase; }
    .tag { display: inline-block; margin: 10px 0 18px; padding: 5px 8px; border: 1px solid var(--line); border-radius: 999px; color: var(--muted); font: 800 10px/1 var(--mono); text-transform: uppercase; }
    .port-card p { color: #453f34; line-height: 1.45; min-height: 82px; }
    .port-card ul { list-style: none; padding: 0; margin: 0; display: grid; gap: 8px; }
    .port-card li { font: 700 12px/1.25 var(--mono); color: #2d2a23; }
    .port-card li::before { content: "↳ "; color: var(--accent); }
    .data { --accent: var(--blue); }
    .cache { --accent: var(--green); }
    .blob { --accent: var(--hot); }
    .queue { --accent: var(--violet); }
    .search { --accent: #b7791f; }

    .strip {
      border: 2px solid var(--ink);
      border-radius: 30px;
      background: var(--ink);
      color: var(--paper);
      box-shadow: var(--shadow);
      overflow: hidden;
    }
    .strip-grid { display: grid; grid-template-columns: 1fr 1fr; }
    .panel { padding: 30px; border-right: 1px solid rgba(245,237,219,.18); }
    .panel:last-child { border-right: 0; }
    .panel h3 { margin: 0 0 16px; font: 900 15px/1 var(--mono); text-transform: uppercase; color: #ffd166; }
    pre {
      margin: 0;
      white-space: pre-wrap;
      font: 13px/1.6 var(--mono);
      color: #f8edd6;
    }
    code { font-family: var(--mono); }
    .comment { color: #9f998d; }
    .endpoint { color: #9ee493; }
    .method { color: #ffd166; }

    .flow {
      display: grid;
      grid-template-columns: repeat(3, 1fr);
      gap: 16px;
    }
    .flow-card {
      padding: 24px;
      border: 2px solid var(--ink);
      border-radius: 24px;
      background: rgba(255,255,255,.45);
      box-shadow: 7px 7px 0 rgba(18,16,12,.10);
    }
    .flow-card b { font: 900 13px/1 var(--mono); color: var(--hot); text-transform: uppercase; }
    .flow-card h3 { margin: 12px 0 10px; font: 900 26px/1.05 var(--serif); letter-spacing: -.03em; }
    .flow-card p { margin: 0; color: var(--muted); line-height: 1.45; }

    footer {
      padding: 50px 0 70px;
      color: var(--muted);
      font: 700 12px/1.5 var(--mono);
      text-transform: uppercase;
      letter-spacing: .05em;
    }

    @media (max-width: 980px) {
      .hero, .section-head, .strip-grid { grid-template-columns: 1fr; }
      .machine { min-height: 500px; transform: none; }
      .ports { grid-template-columns: repeat(2, 1fr); }
      .flow { grid-template-columns: 1fr; }
      .rail { grid-template-columns: repeat(2, 1fr); }
      .nav-links { display: none; }
    }
    @media (max-width: 620px) {
      .ports, .rail { grid-template-columns: 1fr; }
      .node { width: 112px; font-size: 10px; }
      .core { width: 150px; height: 150px; }
      header { padding-top: 48px; }
    }
  </style>
</head>
<body>
  <nav>
    <div class="wrap nav-inner">
      <div class="brand"><span class="mark"></span> hyper-mcp</div>
      <div class="nav-links">
        <a href="#ports">Ports</a>
        <a href="#connect">Connect</a>
        <a href="#deploy">Deploy</a>
      </div>
    </div>
  </nav>

  <header class="wrap hero">
    <div>
      <span class="eyebrow"><span class="pulse"></span> MCP server for ScoutOS agents</span>
      <h1>Five ports. <em>One</em> agent gateway.</h1>
      <p class="lede"><strong>hyper-mcp</strong> exposes ScoutOS-style data, cache, blob, queue, and search capabilities over the Model Context Protocol, backed by persistent PGLite on disk for a small, shippable MVP.</p>
      <div class="actions">
        <a class="btn" href="/mcp">MCP endpoint →</a>
        <a class="btn secondary" href="/health">Health check</a>
      </div>
      <div class="rail" aria-label="Project stats">
        <div class="stat"><b>5</b><span>ScoutOS ports</span></div>
        <div class="stat"><b>50+</b><span>MCP tools</span></div>
        <div class="stat"><b>1</b><span>PGLite store</span></div>
        <div class="stat"><b>18</b><span>Port tests</span></div>
      </div>
    </div>

    <div class="machine" aria-label="PGLite-backed port diagram">
      <div class="diagram">
        <div class="core">PGLite<br/>persistent<br/>disk</div>
        <div class="node n-data">Data<small>documents</small></div>
        <div class="node n-cache">Cache<small>TTL state</small></div>
        <div class="node n-blob">Blob<small>artifacts</small></div>
        <div class="node n-queue">Queue<small>workflows</small></div>
        <div class="node n-search">Search<small>retrieval</small></div>
      </div>
    </div>
  </header>

  <main>
    <section id="ports" class="wrap">
      <div class="section-head">
        <h2>Ports agents can actually use.</h2>
        <p>Each port is exposed as explicit MCP tools with JSON schemas. Agents get stable verbs instead of raw database access, while the server keeps persistence, limits, and safety checks in one place.</p>
      </div>
      <div class="ports">
        <article class="port-card data">
          <h3>Data</h3><span class="tag">JSON documents</span>
          <p>Collections for durable agent state, run records, memory metadata, configs, and structured application data.</p>
          <ul><li>create / get / update / delete</li><li>find, count, bulk</li><li>indexes and collections</li></ul>
        </article>
        <article class="port-card cache">
          <h3>Cache</h3><span class="tag">TTL key-value</span>
          <p>Short-lived state for sessions, counters, locks, dedupe keys, and hot working memory.</p>
          <ul><li>set / get / exists</li><li>ttl expiry</li><li>incr / decr</li></ul>
        </article>
        <article class="port-card blob">
          <h3>Blob</h3><span class="tag">Files & artifacts</span>
          <p>Store generated files, screenshots, transcripts, embeddings payloads, and exported agent artifacts.</p>
          <ul><li>text and base64 upload</li><li>metadata, list, copy</li><li>pseudo signed URLs</li></ul>
        </article>
        <article class="port-card queue">
          <h3>Queue</h3><span class="tag">Async work</span>
          <p>Topic-based message flow for background jobs, fanout tasks, event pipelines, and agent handoffs.</p>
          <ul><li>topics and publish</li><li>subscriptions and poll</li><li>ack, nack, seek</li></ul>
        </article>
        <article class="port-card search">
          <h3>Search</h3><span class="tag">Retrieval layer</span>
          <p>Persistent document indexes for lightweight full-text retrieval and simple query DSL in the MVP.</p>
          <ul><li>create index</li><li>index and bulk docs</li><li>query, count, health</li></ul>
        </article>
      </div>
    </section>

    <section id="connect" class="wrap">
      <div class="strip">
        <div class="strip-grid">
          <div class="panel">
            <h3>HTTP MCP endpoint</h3>
            <pre><span class="method">POST</span> <span class="endpoint">/mcp</span>
<span class="comment"># Streamable HTTP transport for hosted MCP clients</span>

<span class="method">GET</span> <span class="endpoint">/health</span>
<span class="comment"># Render health check + backend summary</span></pre>
          </div>
          <div class="panel">
            <h3>Persistent deploy config</h3>
            <pre>HYPER_MCP_PGLITE_DIR=/var/data/pgdata
HYPER_MCP_READONLY=false
HYPER_MCP_ALLOW_DANGEROUS=false

<span class="comment"># Render disk mount</span>
/var/data → PGLite database files</pre>
          </div>
        </div>
      </div>
    </section>

    <section id="deploy" class="wrap">
      <div class="section-head">
        <h2>Small enough to deploy. Useful enough to keep.</h2>
        <p>The MVP is a single Node service. No external Postgres, Redis, S3, Kafka, or OpenSearch required. Render supplies the disk; PGLite supplies the local Postgres-compatible core.</p>
      </div>
      <div class="flow">
        <div class="flow-card"><b>01</b><h3>Deploy the Blueprint</h3><p><code>render.yaml</code> creates a web service with a persistent disk and points PGLite at <code>/var/data/pgdata</code>.</p></div>
        <div class="flow-card"><b>02</b><h3>Connect agents</h3><p>Point MCP clients at <code>https://your-service.onrender.com/mcp</code> and let tools discover the port surface.</p></div>
        <div class="flow-card"><b>03</b><h3>Graduate adapters later</h3><p>The public contract follows ScoutOS ports, so PGLite can be swapped for remote ScoutOS adapters as the service grows.</p></div>
      </div>
    </section>
  </main>

  <footer class="wrap">
    hyper-mcp · ScoutOS-style ports · Model Context Protocol · persistent PGLite MVP
  </footer>
</body>
</html>`;
}

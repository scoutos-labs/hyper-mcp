#!/usr/bin/env node
import { createMcpExpressApp } from "@modelcontextprotocol/sdk/server/express.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { loadConfig } from "./config.js";
import { createServer } from "./server.js";
import { landingPage } from "./landing.js";

const port = Number(process.env.PORT || 3000);
const host = process.env.HOST || "0.0.0.0";
const config = loadConfig();
const server = createServer(config);
const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });

const app = createMcpExpressApp({ host });

app.get("/", (_req: any, res: any) => {
  res.status(200).type("html").send(landingPage());
});

app.get("/health", (_req: any, res: any) => {
  res.status(200).json({
    ok: true,
    service: "hyper-mcp",
    backend: "pglite",
    persistentDir: config.pgDir,
    readOnly: config.readOnly,
  });
});

app.post("/mcp", async (req: any, res: any) => {
  try {
    await transport.handleRequest(req, res, req.body);
  } catch (error) {
    console.error("MCP request failed", error);
    if (!res.headersSent) {
      res.status(500).json({
        jsonrpc: "2.0",
        error: { code: -32603, message: "Internal server error" },
        id: null,
      });
    }
  }
});

app.get("/mcp", (_req: any, res: any) => {
  res.status(405).json({
    jsonrpc: "2.0",
    error: { code: -32000, message: "Method not allowed. Use POST /mcp." },
    id: null,
  });
});

app.delete("/mcp", (_req: any, res: any) => {
  res.status(405).json({
    jsonrpc: "2.0",
    error: { code: -32000, message: "Method not allowed." },
    id: null,
  });
});

await server.connect(transport);

const listener = app.listen(port, host, (error?: Error) => {
  if (error) {
    console.error("Failed to start hyper-mcp HTTP server", error);
    process.exit(1);
  }
  console.log(`hyper-mcp HTTP server listening on ${host}:${port}`);
  console.log(`MCP endpoint: /mcp`);
});

async function shutdown() {
  console.log("Shutting down hyper-mcp HTTP server...");
  listener.close();
  await transport.close();
  await server.close();
  process.exit(0);
}

process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);

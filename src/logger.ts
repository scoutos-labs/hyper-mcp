/**
 * Structured JSON logger for hyper-mcp.
 *
 * Outputs one JSON object per line to stdout (info) and stderr (error),
 * compatible with Render's log ingest and tools like `jq`.
 *
 * Log levels: debug | info | warn | error
 *
 * Set HYPER_MCP_LOG_LEVEL to control verbosity:
 *   debug | info | warn | error
 *
 * Set HYPER_MCP_LOG_FORMAT=pretty for local dev (human-readable).
 */

export type LogLevel = "debug" | "info" | "warn" | "error";

const LEVEL_PRIORITY: Record<LogLevel, number> = {
  debug: 10,
  info: 20,
  warn: 30,
  error: 40,
};

const envLevel = (process.env.HYPER_MCP_LOG_LEVEL || "info") as LogLevel;
const minPriority = LEVEL_PRIORITY[envLevel] ?? LEVEL_PRIORITY.info;
const pretty = process.env.HYPER_MCP_LOG_FORMAT === "pretty";

interface LogEntry {
  ts: string;
  level: LogLevel;
  msg: string;
  [key: string]: unknown;
}

function format(entry: LogEntry): string {
  if (pretty) {
    const color = entry.level === "error" ? "\x1b[31m" : entry.level === "warn" ? "\x1b[33m" : entry.level === "debug" ? "\x1b[90m" : "\x1b[36m";
    const reset = "\x1b[0m";
    const extra = Object.entries(entry)
      .filter(([k]) => k !== "ts" && k !== "level" && k !== "msg")
      .map(([k, v]) => `${k}=${typeof v === "object" ? JSON.stringify(v) : v}`)
      .join(" ");
    return `${color}[${entry.ts}]${reset} ${entry.level.toUpperCase().padEnd(5)} ${entry.msg}${extra ? " " + extra : ""}`;
  }
  return JSON.stringify(entry);
}

function log(level: LogLevel, msg: string, data?: Record<string, unknown>) {
  const priority = LEVEL_PRIORITY[level];
  if (priority < minPriority) return;

  const entry: LogEntry = {
    ts: new Date().toISOString(),
    level,
    msg,
    ...data,
  };

  const line = format(entry);
  if (level === "error" || level === "warn") {
    process.stderr.write(line + "\n");
  } else {
    process.stdout.write(line + "\n");
  }
}

export const logger = {
  debug: (msg: string, data?: Record<string, unknown>) => log("debug", msg, data),
  info: (msg: string, data?: Record<string, unknown>) => log("info", msg, data),
  warn: (msg: string, data?: Record<string, unknown>) => log("warn", msg, data),
  error: (msg: string, data?: Record<string, unknown>) => log("error", msg, data),
};

// Timer helper for performance metrics
export function startTimer(label: string, data?: Record<string, unknown>) {
  const start = performance.now();
  const startMs = Date.now();
  return {
    end: (extra?: Record<string, unknown>) => {
      const durationMs = Math.round(performance.now() - start);
      log("info", label, {
        durationMs,
        startEpoch: startMs,
        ...data,
        ...extra,
      });
      return durationMs;
    },
  };
}

// In-process metrics counters
const metrics = {
  requests: 0,
  requestsByStatus: {} as Record<number, number>,
  requestsByRoute: {} as Record<string, number>,
  toolCalls: 0,
  toolCallsByTool: {} as Record<string, number>,
  toolErrors: 0,
  authFailures: 0,
  startTime: Date.now(),
};

export function recordToolCall(tool: string, success: boolean) {
  metrics.toolCalls++;
  metrics.toolCallsByTool[tool] = (metrics.toolCallsByTool[tool] || 0) + 1;
  if (!success) metrics.toolErrors++;
}

export function recordAuthFailure() {
  metrics.authFailures++;
}

export function getMetrics() {
  return {
    ...metrics,
    uptimeSeconds: Math.round((Date.now() - metrics.startTime) / 1000),
  };
}

// Express request logger middleware
export function requestLogger() {
  return (req: any, res: any, next: any) => {
    const start = performance.now();
    const method = req.method;
    const url = req.url;
    const requestId = req.headers["x-request-id"] || crypto.randomUUID();

    res.on("finish", () => {
      const durationMs = Math.round(performance.now() - start);
      const level: LogLevel = res.statusCode >= 500 ? "error" : res.statusCode >= 400 ? "warn" : "info";

      metrics.requests++;
      metrics.requestsByStatus[res.statusCode] = (metrics.requestsByStatus[res.statusCode] || 0) + 1;
      const route = url.split("?")[0];
      metrics.requestsByRoute[route] = (metrics.requestsByRoute[route] || 0) + 1;

      log(level, `${method} ${url} ${res.statusCode}`, {
        method,
        url,
        status: res.statusCode,
        durationMs,
        requestId,
        ...(req.__auth?.accountId ? { accountId: req.__auth.accountId } : {}),
      });
    });

    next();
  };
}
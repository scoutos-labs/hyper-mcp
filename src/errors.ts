export class PortError extends Error {
  constructor(
    public code: string,
    message: string,
    public status = 400,
    public details?: Array<{ field?: string; message: string }>,
  ) {
    super(message);
    this.name = "PortError";
  }
}

export function toToolError(error: unknown): { content: Array<{ type: "text"; text: string }>; isError: true } {
  const err = error instanceof Error ? error : new Error(String(error));
  const payload = {
    ok: false,
    error: err.message,
    code: error instanceof PortError ? error.code : "INTERNAL_ERROR",
    status: error instanceof PortError ? error.status : 500,
    details: error instanceof PortError ? error.details : undefined,
  };
  return { isError: true, content: [{ type: "text", text: JSON.stringify(payload, null, 2) }] };
}

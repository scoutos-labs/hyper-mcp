import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

/**
 * Landing page served at GET /.
 *
 * Read from disk rather than embedded as a template literal so the HTML
 * gets syntax highlighting, editor tooling, and can be previewed in a
 * browser without going through the server. A cached in-memory copy keeps
 * the hot path fast.
 */
let cachedHtml: string | undefined;

export async function landingPage(): Promise<string> {
  if (cachedHtml) return cachedHtml;
  const path = join(__dirname, "..", "public", "landing.html");
  cachedHtml = await readFile(path, "utf8");
  return cachedHtml;
}

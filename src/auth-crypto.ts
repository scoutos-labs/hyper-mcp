import { randomBytes, scrypt as scryptCb, timingSafeEqual, createHash, randomUUID } from "node:crypto";
import { promisify } from "node:util";

const scrypt = promisify(scryptCb) as (
  password: string | Buffer,
  salt: string | Buffer,
  keylen: number,
  options?: { N?: number; r?: number; p?: number },
) => Promise<Buffer>;

// scrypt parameters — reasonable defaults for interactive login on a single-process server.
const SCRYPT_N = 16384;
const SCRYPT_R = 8;
const SCRYPT_P = 1;
const SCRYPT_KEYLEN = 32;
const SCRYPT_SALTLEN = 16;

/**
 * Hash a password with scrypt and return a self-describing encoded string:
 *   scrypt$<saltB64>$<hashB64>$<N>:<r>:<p>
 * The encoding is stored in `auth_credentials.hash`.
 */
export async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(SCRYPT_SALTLEN);
  const hash = await scrypt(password, salt, SCRYPT_KEYLEN, { N: SCRYPT_N, r: SCRYPT_R, p: SCRYPT_P });
  return `scrypt$${salt.toString("base64")}$${hash.toString("base64")}$${SCRYPT_N}:${SCRYPT_R}:${SCRYPT_P}`;
}

/** Verify a password against an encoded scrypt string. Constant-time hash compare. */
export async function verifyPassword(password: string, encoded: string): Promise<boolean> {
  const parts = encoded.split("$");
  if (parts.length !== 4 || parts[0] !== "scrypt") return false;
  const [, saltB64, hashB64, params] = parts;
  const [Ns, rs, ps] = params.split(":");
  const N = Number(Ns);
  const r = Number(rs);
  const p = Number(ps);
  if (!Number.isFinite(N) || !Number.isFinite(r) || !Number.isFinite(p)) return false;
  let salt: Buffer, expected: Buffer;
  try {
    salt = Buffer.from(saltB64, "base64");
    expected = Buffer.from(hashB64, "base64");
  } catch {
    return false;
  }
  const hash = await scrypt(password, salt, expected.length, { N, r, p });
  if (hash.length !== expected.length) return false;
  return timingSafeEqual(hash, expected);
}

/** Generate an opaque url-safe session token of `bytes` random bytes (default 32). */
export function randomToken(bytes = 32): string {
  return randomBytes(bytes).toString("base64url");
}

/** SHA-256 of a string, returned as hex. Used to store session tokens and codes by hash. */
export function sha256Hex(s: string): string {
  return createHash("sha256").update(s).digest("hex");
}

/** Generate a 6-digit zero-padded one-time code. */
export function generateCode(): string {
  // 6 digits => 0..999999
  const n = randomBytes(4).readUInt32BE(0) % 1_000_000;
  return n.toString().padStart(6, "0");
}

/** New id helper (re-export so auth methods don't all need to import from crypto). */
export function newId(): string {
  return randomUUID();
}
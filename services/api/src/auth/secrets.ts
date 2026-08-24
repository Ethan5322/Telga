/**
 * Hashing and token generation.
 *
 * The only file in the repository that turns a secret into something storable,
 * and the only one that generates one.
 *
 * ## Why scrypt
 *
 * It is in `node:crypto`. Adding argon2 would mean a native dependency, a build
 * step and a supply-chain question, to defend a six-digit training PIN that is
 * already defended by lockout and by device binding. scrypt with a real work
 * factor is the honest choice here, and `pin_params` records the factor used so
 * a future rehash can detect an old one rather than guess.
 *
 * ## Comparison is constant-time
 *
 * `timingSafeEqual`, always, and on equal-length buffers — a length mismatch is
 * answered with a dummy comparison so the failure path costs the same. A PIN
 * space of a million values does not need much of a timing edge to be worth
 * grinding.
 *
 * ## Nothing here logs
 *
 * No function in this file writes to stdout, and none of them returns the
 * plaintext it was given. The raw PIN, the device secret and the session token
 * exist only as arguments and as a single return value at generation time.
 */

import {
  createHash,
  randomBytes,
  scrypt as scryptCallback,
  timingSafeEqual,
} from 'node:crypto';
import { promisify } from 'node:util';

const scrypt = promisify(scryptCallback) as (
  password: string | Buffer,
  salt: string | Buffer,
  keylen: number,
  options: { N: number; r: number; p: number; maxmem: number },
) => Promise<Buffer>;

/**
 * Work factor.
 *
 * `N = 16384` costs roughly 16MB and tens of milliseconds — enough to make a
 * million-value PIN space expensive to grind offline, cheap enough that a
 * counter sign-in feels instant. **Training values**; production parameters are
 * NOT YET CONFIRMED and belong with a security review.
 */
export const SCRYPT_PARAMS = Object.freeze({ N: 16_384, r: 8, p: 1, keylen: 64 });

export const SCRYPT_MAXMEM = 64 * 1024 * 1024;

/** Describes the parameters a stored hash was produced with. */
export function describeParams(params = SCRYPT_PARAMS): string {
  return `scrypt$N=${String(params.N)},r=${String(params.r)},p=${String(params.p)},len=${String(params.keylen)}`;
}

export interface DerivedSecret {
  readonly hash: string;
  readonly salt: string;
  readonly params: string;
}

/** Derive a storable value from a secret. The secret is never returned. */
export async function deriveSecret(secret: string): Promise<DerivedSecret> {
  const salt = randomBytes(16);
  const derived = await scrypt(secret, salt, SCRYPT_PARAMS.keylen, {
    N: SCRYPT_PARAMS.N,
    r: SCRYPT_PARAMS.r,
    p: SCRYPT_PARAMS.p,
    maxmem: SCRYPT_MAXMEM,
  });
  return {
    hash: derived.toString('hex'),
    salt: salt.toString('hex'),
    params: describeParams(),
  };
}

/**
 * Verify a secret against a stored derivation.
 *
 * Returns false rather than throwing for a malformed stored value: a corrupted
 * row must fail closed, not crash the sign-in path for everyone else.
 */
export async function verifySecret(secret: string, stored: DerivedSecret): Promise<boolean> {
  let expected: Buffer;
  try {
    expected = Buffer.from(stored.hash, 'hex');
  } catch {
    return false;
  }
  if (expected.length === 0) return false;

  const params = parseParams(stored.params);
  let actual: Buffer;
  try {
    actual = await scrypt(secret, Buffer.from(stored.salt, 'hex'), expected.length, {
      N: params.N,
      r: params.r,
      p: params.p,
      maxmem: SCRYPT_MAXMEM,
    });
  } catch {
    return false;
  }
  if (actual.length !== expected.length) return false;
  return timingSafeEqual(actual, expected);
}

function parseParams(value: string): { N: number; r: number; p: number } {
  const match = /^scrypt\$N=(\d+),r=(\d+),p=(\d+)/.exec(value);
  if (!match) return { N: SCRYPT_PARAMS.N, r: SCRYPT_PARAMS.r, p: SCRYPT_PARAMS.p };
  return {
    N: Number(match[1]),
    r: Number(match[2]),
    p: Number(match[3]),
  };
}

// --- tokens -----------------------------------------------------------------

/** 256 bits from the OS. Never `Math.random`, never a counter, never a uuid. */
export function newToken(bytes = 32): string {
  return randomBytes(bytes).toString('base64url');
}

/**
 * The lookup key for a token.
 *
 * A plain SHA-256, not scrypt: a 256-bit random token has no structure to
 * grind, so a work factor would only slow every request down. What matters is
 * that the token itself is never stored, so a stolen database yields no usable
 * session.
 */
export function tokenFingerprint(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

/** Constant-time comparison of two tokens supplied as strings. */
export function tokensMatch(a: string, b: string): boolean {
  const left = Buffer.from(a);
  const right = Buffer.from(b);
  if (left.length !== right.length) {
    // Compare something of equal length anyway, so a length mismatch is not
    // cheaper to detect than a value mismatch.
    timingSafeEqual(left, left);
    return false;
  }
  return timingSafeEqual(left, right);
}

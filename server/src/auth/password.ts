import { randomBytes, scrypt, timingSafeEqual, type ScryptOptions } from 'node:crypto';
import { promisify } from 'node:util';

// `scrypt` is overloaded (with and without an options argument), and
// `promisify` resolves to the shorter one. Cast to the signature actually
// used here rather than dropping to scryptSync, which would block the event
// loop for the ~100ms this cost takes on every login.
const scryptAsync = promisify(scrypt) as (
  password: string,
  salt: Buffer,
  keylen: number,
  options: ScryptOptions
) => Promise<Buffer>;

/**
 * Node's own recommended scrypt cost parameters (N=2^14, r=8, p=1). Chosen
 * over bcrypt/argon2 so the auth work adds no dependency and needs no native
 * build in the Docker image — consistent with the engines' zero-npm-deps
 * stance elsewhere in this repo.
 */
const COST = 16384;
const BLOCK_SIZE = 8;
const PARALLELIZATION = 1;
const SALT_LENGTH = 16;
const KEY_LENGTH = 64;

/**
 * `scrypt$<N>$<r>$<p>$<salt>$<hash>`, both binary fields base64. The cost
 * parameters travel with the hash rather than living in code, so COST can
 * change later without invalidating passwords hashed under the old value —
 * verifyPassword always uses whatever is stored.
 */
export async function hashPassword(plain: string): Promise<string> {
  const salt = randomBytes(SALT_LENGTH);
  const derived = await scryptAsync(plain, salt, KEY_LENGTH, {
    N: COST,
    r: BLOCK_SIZE,
    p: PARALLELIZATION,
  });
  return `scrypt$${COST}$${BLOCK_SIZE}$${PARALLELIZATION}$${salt.toString('base64')}$${derived.toString('base64')}`;
}

/**
 * Constant-time comparison against a stored hash of unknown shape. A
 * malformed or corrupted `stored` value must fail closed — return false —
 * rather than throw, which would turn a bad row into a 500 instead of a
 * refused login. Deriving with `expected.length` as the key length is what
 * keeps the final `timingSafeEqual` call safe: it throws on a length
 * mismatch, so mismatched buffers are never handed to it.
 */
export async function verifyPassword(plain: string, stored: string): Promise<boolean> {
  const parts = stored.split('$');
  if (parts.length !== 6 || parts[0] !== 'scrypt') return false;

  const [, costStr, blockSizeStr, parallelizationStr, saltB64, hashB64] = parts;
  const N = Number(costStr);
  const r = Number(blockSizeStr);
  const p = Number(parallelizationStr);
  if (!Number.isInteger(N) || !Number.isInteger(r) || !Number.isInteger(p)) return false;

  let salt: Buffer;
  let expected: Buffer;
  try {
    salt = Buffer.from(saltB64, 'base64');
    expected = Buffer.from(hashB64, 'base64');
  } catch {
    return false;
  }
  if (salt.length === 0 || expected.length === 0) return false;

  let derived: Buffer;
  try {
    derived = await scryptAsync(plain, salt, expected.length, { N, r, p });
  } catch {
    // Out-of-range parameters (e.g. N not a power of two) — a corrupted row,
    // not a wrong password.
    return false;
  }

  return timingSafeEqual(derived, expected);
}

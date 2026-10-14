/**
 * Everything cryptographic in one place, built on node:crypto only — no native modules to build
 * and nothing to keep patched.
 *
 *   passwords   scrypt (N=2^15, r=8, p=1) with a per-password salt, compared in constant time
 *   tokens      256 bits of randomness; only the SHA-256 is stored, so a stolen database row
 *               cannot be replayed as a session
 *   codes       6 digits from rejection-free random bytes, stored as a keyed SHA-256
 *   secrets     AES-256-GCM with a key derived from SECRET_KEY (CRM tokens, webhook secrets)
 */
import {
  createCipheriv, createDecipheriv, createHash, createHmac, randomBytes, randomInt, scrypt,
  timingSafeEqual,
} from 'node:crypto';
import { promisify } from 'node:util';
import { loadEnv } from './env';

const scryptAsync = promisify(scrypt) as (p: string | Buffer, s: Buffer, len: number, opts: { N: number; r: number; p: number; maxmem: number }) => Promise<Buffer>;

const PARAMS = { N: 1 << 15, r: 8, p: 1, maxmem: 64 * 1024 * 1024 };

/** `scrypt$N$r$p$salt$hash`, so the cost can be raised later without invalidating old hashes. */
export async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(16);
  const hash = await scryptAsync(password.normalize('NFKC'), salt, 32, PARAMS);
  return `scrypt$${PARAMS.N}$${PARAMS.r}$${PARAMS.p}$${salt.toString('base64url')}$${hash.toString('base64url')}`;
}

export async function verifyPassword(password: string, stored: string | null | undefined): Promise<boolean> {
  if (!stored) return false;
  const [scheme, N, r, p, salt, hash] = stored.split('$');
  if (scheme !== 'scrypt' || !N || !r || !p || !salt || !hash) return false;
  const expected = Buffer.from(hash, 'base64url');
  const actual = await scryptAsync(password.normalize('NFKC'), Buffer.from(salt, 'base64url'), expected.length, {
    N: Number(N), r: Number(r), p: Number(p), maxmem: PARAMS.maxmem,
  });
  return expected.length === actual.length && timingSafeEqual(expected, actual);
}

/** A session token: what the browser keeps. The database only ever sees `sha256()` of it. */
export const newToken = () => randomBytes(32).toString('base64url');

export const sha256 = (value: string) => createHash('sha256').update(value).digest('hex');

/** Emailed codes are keyed, so the hashes in password_codes are useless on their own. */
export const hashCode = (code: string) =>
  createHmac('sha256', loadEnv().SECRET_KEY).update(code.replace(/\s/g, '')).digest('hex');

export const sixDigits = () => String(randomInt(0, 1_000_000)).padStart(6, '0');

/** Recovery codes read out loud: ABCD-EFGH, no look-alike characters. */
export function recoveryCode(): string {
  const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  const pick = () => Array.from({ length: 4 }, () => alphabet[randomInt(alphabet.length)]).join('');
  return `${pick()}-${pick()}`;
}

export const equalInTime = (a: string, b: string) => {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
};

// ---------------------------------------------------------------- secrets at rest
const key = () => createHash('sha256').update(`wetasnap:v1:${loadEnv().SECRET_KEY}`).digest();

export function encryptSecret(plain: string): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key(), iv);
  const body = Buffer.concat([cipher.update(plain, 'utf8'), cipher.final()]);
  return `v1.${iv.toString('base64url')}.${cipher.getAuthTag().toString('base64url')}.${body.toString('base64url')}`;
}

export function decryptSecret(blob: string): string {
  const [version, iv, tag, body] = blob.split('.');
  if (version !== 'v1' || !iv || !tag || !body) throw new Error('That stored secret is not readable.');
  const decipher = createDecipheriv('aes-256-gcm', key(), Buffer.from(iv, 'base64url'));
  decipher.setAuthTag(Buffer.from(tag, 'base64url'));
  return Buffer.concat([decipher.update(Buffer.from(body, 'base64url')), decipher.final()]).toString('utf8');
}

/** A stable, non-reversible id for rate-limit keys made of personal data (an e-mail, an IP). */
export const keyFor = (value: string) =>
  createHmac('sha256', loadEnv().SECRET_KEY).update(value.toLowerCase()).digest('hex').slice(0, 32);

// ---------------------------------------------------------------- signed file links
/**
 * An <img> tag cannot send an Authorization header, so avatars are reached through a link that
 * carries its own proof: the path and an expiry, signed with SECRET_KEY. Nothing about the person
 * is in the signature, it cannot be moved to another path, and it stops working after `seconds`.
 */
export function signPath(path: string, seconds = 7 * 24 * 3600): string {
  const exp = Math.floor(Date.now() / 1000) + seconds;
  const sig = createHmac('sha256', loadEnv().SECRET_KEY).update(`${path}:${exp}`).digest('base64url').slice(0, 32);
  return `${path}?exp=${exp}&sig=${sig}`;
}

export function pathSignatureOk(path: string, exp: string | undefined, sig: string | undefined): boolean {
  if (!exp || !sig) return false;
  if (Number(exp) * 1000 < Date.now()) return false;
  const expected = createHmac('sha256', loadEnv().SECRET_KEY).update(`${path}:${exp}`).digest('base64url').slice(0, 32);
  return equalInTime(expected, sig);
}

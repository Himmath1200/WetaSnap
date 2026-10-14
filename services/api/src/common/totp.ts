/**
 * Authenticator codes (RFC 6238, SHA-1, 6 digits, 30-second steps) — the same thing Google
 * Authenticator, 1Password and Aegis produce. Written out here rather than pulled in, because it
 * is twenty lines and this way nothing in the sign-in path comes from outside.
 *
 * An authenticator is never required in WeTa Snap (client decision, 26 Sep 2026): it is asked for
 * only by accounts that turned one on themselves in Security.
 */
import { createHmac, randomBytes } from 'node:crypto';

const ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';

export const newSecret = (bytes = 20): string => base32Encode(randomBytes(bytes));

/** The string behind the QR code the authenticator app scans. */
export const otpauthUrl = (secret: string, account: string, issuer = 'WeTa Snap') =>
  `otpauth://totp/${encodeURIComponent(issuer)}:${encodeURIComponent(account)}` +
  `?secret=${secret}&issuer=${encodeURIComponent(issuer)}&algorithm=SHA1&digits=6&period=30`;

/** True when `code` is right for now, allowing one step either side for a slow clock. */
export function verifyTotp(secret: string, code: string, window = 1): boolean {
  const typed = code.replace(/\D/g, '');
  if (typed.length !== 6) return false;
  const counter = Math.floor(Date.now() / 30_000);
  for (let i = -window; i <= window; i += 1) {
    if (totpAt(secret, counter + i) === typed) return true;
  }
  return false;
}

function totpAt(secret: string, counter: number): string {
  const key = base32Decode(secret);
  const buf = Buffer.alloc(8);
  buf.writeBigUInt64BE(BigInt(counter));
  const mac = createHmac('sha1', key).update(buf).digest();
  const offset = mac[mac.length - 1]! & 0x0f;
  const binary = ((mac[offset]! & 0x7f) << 24) | (mac[offset + 1]! << 16) | (mac[offset + 2]! << 8) | mac[offset + 3]!;
  return String(binary % 1_000_000).padStart(6, '0');
}

export function base32Encode(buf: Buffer): string {
  let bits = 0;
  let value = 0;
  let out = '';
  for (const byte of buf) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      out += ALPHABET[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) out += ALPHABET[(value << (5 - bits)) & 31];
  return out;
}

export function base32Decode(secret: string): Buffer {
  const clean = secret.toUpperCase().replace(/[^A-Z2-7]/g, '');
  let bits = 0;
  let value = 0;
  const out: number[] = [];
  for (const char of clean) {
    value = (value << 5) | ALPHABET.indexOf(char);
    bits += 5;
    if (bits >= 8) {
      out.push((value >>> (bits - 8)) & 0xff);
      bits -= 8;
    }
  }
  return Buffer.from(out);
}

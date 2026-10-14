// Web Push (RFC 8291 "aes128gcm" + RFC 8292 VAPID) on WebCrypto, which Node has built in — so
// notifications need no dependency and nothing to keep patched.
//
// Settings: VAPID_PUBLIC_KEY (base64url, 65-byte uncompressed P-256 point)
//           VAPID_PRIVATE_KEY (base64url, 32-byte scalar)
//           VAPID_SUBJECT (mailto: or https: URL identifying WeTano)
// Without them, push is simply off and notifications stay in the app.
import { loadEnv } from './env';

const env = loadEnv();
const VAPID_PUBLIC = (env.VAPID_PUBLIC_KEY ?? '').trim();
const VAPID_PRIVATE = (env.VAPID_PRIVATE_KEY ?? '').trim();
const VAPID_SUBJECT = (env.VAPID_SUBJECT ?? 'mailto:support@wetano.com').trim();

type CryptoKeyLike = Awaited<ReturnType<typeof crypto.subtle.importKey>>;

const enc = new TextEncoder();

export function vapidConfigured(): boolean {
  return VAPID_PUBLIC.length > 0 && VAPID_PRIVATE.length > 0;
}

export function b64urlToBytes(s: string): Uint8Array {
  const b64 = s.replace(/-/g, '+').replace(/_/g, '/');
  const bin = atob(b64.padEnd(b64.length + ((4 - (b64.length % 4)) % 4), '='));
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

export function bytesToB64url(b: Uint8Array): string {
  let s = '';
  for (const x of b) s += String.fromCharCode(x);
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function concat(...parts: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let at = 0;
  for (const p of parts) { out.set(p, at); at += p.length; }
  return out;
}

async function hmac(key: Uint8Array, data: Uint8Array): Promise<Uint8Array> {
  const k = await crypto.subtle.importKey('raw', key, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  return new Uint8Array(await crypto.subtle.sign('HMAC', k, data));
}

/** HKDF-Expand with a single output block (every length we need is ≤ 32 bytes). */
async function expand(prk: Uint8Array, info: Uint8Array, length: number): Promise<Uint8Array> {
  return (await hmac(prk, concat(info, Uint8Array.of(1)))).slice(0, length);
}

let vapidKey: Awaited<ReturnType<typeof crypto.subtle.importKey>> | null = null;
async function vapidSigningKey() {
  if (vapidKey) return vapidKey;
  const pub = b64urlToBytes(VAPID_PUBLIC);
  if (pub.length !== 65 || pub[0] !== 0x04) throw new Error('VAPID_PUBLIC_KEY must be a 65-byte uncompressed P-256 point');
  vapidKey = await crypto.subtle.importKey(
    'jwk',
    {
      kty: 'EC', crv: 'P-256', ext: true,
      d: VAPID_PRIVATE.replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, ''),
      x: bytesToB64url(pub.slice(1, 33)),
      y: bytesToB64url(pub.slice(33, 65)),
    },
    { name: 'ECDSA', namedCurve: 'P-256' },
    false,
    ['sign'],
  );
  return vapidKey;
}

/** `Authorization: vapid t=<ES256 JWT>, k=<public key>` for one push service origin. */
async function vapidAuthorization(endpoint: string): Promise<string> {
  const header = bytesToB64url(enc.encode(JSON.stringify({ typ: 'JWT', alg: 'ES256' })));
  const claims = bytesToB64url(enc.encode(JSON.stringify({
    aud: new URL(endpoint).origin,
    exp: Math.floor(Date.now() / 1000) + 12 * 3600,
    sub: VAPID_SUBJECT,
  })));
  const input = `${header}.${claims}`;
  // WebCrypto returns the raw r||s pair, which is exactly the JWS ES256 signature.
  const sig = new Uint8Array(await crypto.subtle.sign(
    { name: 'ECDSA', hash: 'SHA-256' }, await vapidSigningKey(), enc.encode(input)));
  return `vapid t=${input}.${bytesToB64url(sig)}, k=${VAPID_PUBLIC}`;
}

export interface PushTarget { endpoint: string; p256dh: string; auth: string }

/** RFC 8291 §3.4: one aes128gcm record carrying the whole payload. */
async function encryptPayload(target: PushTarget, payload: string): Promise<Uint8Array> {
  const uaPublic = b64urlToBytes(target.p256dh);
  const authSecret = b64urlToBytes(target.auth);
  if (uaPublic.length !== 65) throw new Error('bad p256dh key');
  if (authSecret.length !== 16) throw new Error('bad auth secret');

  const as = await crypto.subtle.generateKey({ name: 'ECDH', namedCurve: 'P-256' }, true, ['deriveBits']) as { publicKey: CryptoKeyLike; privateKey: CryptoKeyLike };
  const asPublic = new Uint8Array(await crypto.subtle.exportKey('raw', as.publicKey));
  const uaKey = await crypto.subtle.importKey('raw', uaPublic, { name: 'ECDH', namedCurve: 'P-256' }, false, []);
  const shared = new Uint8Array(await crypto.subtle.deriveBits({ name: 'ECDH', public: uaKey }, as.privateKey, 256));

  const prkKey = await hmac(authSecret, shared);
  const ikm = await expand(prkKey, concat(enc.encode('WebPush: info\0'), uaPublic, asPublic), 32);

  const salt = crypto.getRandomValues(new Uint8Array(16));
  const prk = await hmac(salt, ikm);
  const cek = await expand(prk, enc.encode('Content-Encoding: aes128gcm\0'), 16);
  const nonce = await expand(prk, enc.encode('Content-Encoding: nonce\0'), 12);

  const plain = enc.encode(payload);
  if (plain.length > 3900) throw new Error('push payload too long');
  const key = await crypto.subtle.importKey('raw', cek, 'AES-GCM', false, ['encrypt']);
  const ciphertext = new Uint8Array(await crypto.subtle.encrypt(
    { name: 'AES-GCM', iv: nonce, tagLength: 128 }, key, concat(plain, Uint8Array.of(2))));

  const rs = new Uint8Array(4);
  new DataView(rs.buffer).setUint32(0, 4096);
  return concat(salt, rs, Uint8Array.of(asPublic.length), asPublic, ciphertext);
}

export interface PushOutcome { ok: boolean; status: number; gone: boolean; message?: string }

/** Sends one notification. `gone` = the browser dropped this subscription; delete the row. */
export async function sendPush(target: PushTarget, payload: string, ttlSeconds = 86_400): Promise<PushOutcome> {
  let body: Uint8Array;
  try {
    body = await encryptPayload(target, payload);
  } catch (e) {
    return { ok: false, status: 0, gone: true, message: (e as Error).message }; // unusable keys: drop the row
  }
  try {
    const res = await fetch(target.endpoint, {
      method: 'POST',
      headers: {
        TTL: String(ttlSeconds),
        Urgency: 'normal',
        'Content-Encoding': 'aes128gcm',
        'Content-Type': 'application/octet-stream',
        'Content-Length': String(body.length),
        Authorization: await vapidAuthorization(target.endpoint),
      },
      body,
    });
    if (!res.ok) await res.text().catch(() => '');
    return { ok: res.ok, status: res.status, gone: res.status === 404 || res.status === 410 };
  } catch (e) {
    return { ok: false, status: 0, gone: false, message: (e as Error).message };
  }
}

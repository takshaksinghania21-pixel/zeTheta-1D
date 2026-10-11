import {
  createCipheriv,
  createDecipheriv,
  createHash,
  createHmac,
  randomBytes,
  scrypt,
  timingSafeEqual,
} from 'node:crypto';
import { promisify } from 'node:util';

const scryptAsync = promisify(scrypt) as (
  password: string,
  salt: Buffer,
  keylen: number,
  options: { N: number; r: number; p: number },
) => Promise<Buffer>;

/**
 * AES-256-GCM field encryption for contact details at rest.
 * Format: v1.<keyId>.<iv b64url>.<tag b64url>.<ciphertext b64url>
 * The key id enables rotation: decryptors keep a map of retired keys.
 */
export class FieldEncryptor {
  private readonly keys: Map<string, Buffer>;
  constructor(
    private readonly activeKeyId: string,
    activeKeyBase64: string,
    retiredKeys: Record<string, string> = {},
  ) {
    this.keys = new Map(
      Object.entries(retiredKeys).map(([id, k]) => [id, Buffer.from(k, 'base64')]),
    );
    const key = Buffer.from(activeKeyBase64, 'base64');
    if (key.length !== 32) throw new Error('Encryption key must be 32 bytes');
    this.keys.set(activeKeyId, key);
  }

  encrypt(plaintext: string): string {
    const key = this.keys.get(this.activeKeyId);
    if (!key) throw new Error('Active encryption key missing');
    const iv = randomBytes(12);
    const cipher = createCipheriv('aes-256-gcm', key, iv);
    const ct = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
    const tag = cipher.getAuthTag();
    return [
      'v1',
      this.activeKeyId,
      iv.toString('base64url'),
      tag.toString('base64url'),
      ct.toString('base64url'),
    ].join('.');
  }

  decrypt(payload: string): string {
    const [version, keyId, ivB64, tagB64, ctB64] = payload.split('.');
    if (version !== 'v1' || !keyId || !ivB64 || !tagB64 || ctB64 === undefined) {
      throw new Error('Malformed ciphertext');
    }
    const key = this.keys.get(keyId);
    if (!key) throw new Error(`Unknown encryption key id ${keyId}`);
    const decipher = createDecipheriv('aes-256-gcm', key, Buffer.from(ivB64, 'base64url'));
    decipher.setAuthTag(Buffer.from(tagB64, 'base64url'));
    return Buffer.concat([
      decipher.update(Buffer.from(ctB64, 'base64url')),
      decipher.final(),
    ]).toString('utf8');
  }
}

/** Keyed blind index (HMAC-SHA256) allowing equality lookup without decryption. */
export function blindIndex(keyBase64: string, value: string): string {
  return createHmac('sha256', Buffer.from(keyBase64, 'base64')).update(value).digest('hex');
}

export function sha256Hex(value: string | Buffer): string {
  return createHash('sha256').update(value).digest('hex');
}

export function hmacSha256Hex(secret: string | Buffer, data: string | Buffer): string {
  return createHmac('sha256', secret).update(data).digest('hex');
}

export function hmacSha1Base64(secret: string, data: string): string {
  return createHmac('sha1', secret).update(data).digest('base64');
}

/** Constant-time string comparison that does not leak length via early exit. */
export function safeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  if (ab.length !== bb.length) {
    timingSafeEqual(ab, ab);
    return false;
  }
  return timingSafeEqual(ab, bb);
}

export function randomToken(bytes = 32): string {
  return randomBytes(bytes).toString('base64url');
}

const SCRYPT_PARAMS = { N: 16384, r: 8, p: 1 };

/** Password hashing with scrypt (memory-hard, built into Node). */
export async function hashSecret(secret: string): Promise<string> {
  const salt = randomBytes(16);
  const hash = await scryptAsync(secret, salt, 64, SCRYPT_PARAMS);
  return `scrypt$${SCRYPT_PARAMS.N}$${SCRYPT_PARAMS.r}$${SCRYPT_PARAMS.p}$${salt.toString('base64url')}$${hash.toString('base64url')}`;
}

export async function verifySecret(secret: string, stored: string): Promise<boolean> {
  const parts = stored.split('$');
  if (parts.length !== 6 || parts[0] !== 'scrypt') return false;
  const [, n, r, p, saltB64, hashB64] = parts as [string, string, string, string, string, string];
  const expected = Buffer.from(hashB64, 'base64url');
  const actual = await scryptAsync(secret, Buffer.from(saltB64, 'base64url'), expected.length, {
    N: Number(n),
    r: Number(r),
    p: Number(p),
  });
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}

/** Stable JSON serialisation (sorted keys) for hashing payloads. */
export function stableStringify(value: unknown): string {
  if (value === null || typeof value !== 'object')
    return value === undefined ? 'null' : JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map((v) => stableStringify(v)).join(',')}]`;
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, v]) => v !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${stableStringify(v)}`).join(',')}}`;
}

import { hmacSha1Base64, hmacSha256Hex, safeEqual } from '../../common/crypto';

/**
 * Generic signature used by mock providers and internal relays:
 *   X-Zetheta-Signature: t=<unix seconds>,v1=<hex HMAC-SHA256(secret, "<t>.<rawBody>")>
 * The timestamp bounds replay; duplicate events are also de-duplicated by id.
 */
export function signGeneric(secret: string, rawBody: string, timestampSeconds: number): string {
  return `t=${timestampSeconds},v1=${hmacSha256Hex(secret, `${timestampSeconds}.${rawBody}`)}`;
}

export type SignatureCheck = { valid: true } | { valid: false; reason: string };

export function verifyGeneric(
  secret: string,
  rawBody: string,
  header: string | undefined,
  toleranceSeconds: number,
  nowMs = Date.now(),
): SignatureCheck {
  if (!header) return { valid: false, reason: 'missing signature header' };
  const parts = Object.fromEntries(
    header.split(',').map((p) => p.trim().split('=', 2) as [string, string]),
  );
  const t = Number(parts.t);
  const v1 = parts.v1;
  if (!Number.isInteger(t) || !v1) return { valid: false, reason: 'malformed signature header' };
  if (Math.abs(nowMs / 1000 - t) > toleranceSeconds)
    return { valid: false, reason: 'signature timestamp outside tolerance' };
  const expected = hmacSha256Hex(secret, `${t}.${rawBody}`);
  return safeEqual(expected, v1) ? { valid: true } : { valid: false, reason: 'signature mismatch' };
}

/** Meta / WhatsApp Cloud API: X-Hub-Signature-256: sha256=<hex HMAC-SHA256(appSecret, rawBody)> */
export function verifyMeta(
  appSecret: string,
  rawBody: string,
  header: string | undefined,
): SignatureCheck {
  if (!header?.startsWith('sha256='))
    return { valid: false, reason: 'missing or malformed X-Hub-Signature-256' };
  return safeEqual(`sha256=${hmacSha256Hex(appSecret, rawBody)}`, header)
    ? { valid: true }
    : { valid: false, reason: 'signature mismatch' };
}

/**
 * Twilio: X-Twilio-Signature = base64(HMAC-SHA1(authToken, fullUrl + concat(sorted(key + value))))
 * for application/x-www-form-urlencoded callbacks.
 */
export function twilioSignature(
  authToken: string,
  fullUrl: string,
  params: Record<string, string>,
): string {
  const data = Object.keys(params)
    .sort()
    .reduce((acc, k) => acc + k + (params[k] ?? ''), fullUrl);
  return hmacSha1Base64(authToken, data);
}

export function verifyTwilio(
  authToken: string,
  fullUrl: string,
  params: Record<string, string>,
  header: string | undefined,
): SignatureCheck {
  if (!header) return { valid: false, reason: 'missing X-Twilio-Signature' };
  return safeEqual(twilioSignature(authToken, fullUrl, params), header)
    ? { valid: true }
    : { valid: false, reason: 'signature mismatch' };
}

/** MSG91 does not sign callbacks; a shared secret header is required instead. */
export function verifySharedSecret(secret: string, header: string | undefined): SignatureCheck {
  if (!header) return { valid: false, reason: 'missing shared-secret header' };
  return safeEqual(secret, header)
    ? { valid: true }
    : { valid: false, reason: 'shared secret mismatch' };
}

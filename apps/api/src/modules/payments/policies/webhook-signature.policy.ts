import { createHmac, timingSafeEqual } from 'node:crypto';

/** Verificación pura de la firma del webhook (sin Nest). */

export const WEBHOOK_TOLERANCE_SECONDS = 300;

const TIMESTAMP_RE = /^\d+$/;
const SIGNATURE_RE = /^[0-9a-f]{64}$/i;

/** HMAC-SHA256 hexadecimal de `${timestamp}.${rawBody}`. */
export function computeWebhookSignature(
  secret: string,
  timestamp: string,
  rawBody: string | Buffer,
): string {
  return createHmac('sha256', secret)
    .update(`${timestamp}.`)
    .update(rawBody)
    .digest('hex');
}

export type VerifyWebhookInput = {
  secret: string;
  timestamp: string | undefined;
  rawBody: string | Buffer;
  signature: string | undefined;
  /** Segundos Unix actuales. */
  now: number;
};

/**
 * `true` solo si hay headers bien formados, el timestamp está dentro de ±300 s
 * y la firma coincide (comparada con `timingSafeEqual`).
 */
export function verifyWebhookSignature(input: VerifyWebhookInput): boolean {
  const { secret, timestamp, rawBody, signature, now } = input;
  if (!timestamp || !signature) return false;
  if (!TIMESTAMP_RE.test(timestamp) || !SIGNATURE_RE.test(signature)) return false;

  const ts = Number(timestamp);
  if (!Number.isSafeInteger(ts)) return false;
  if (Math.abs(now - ts) > WEBHOOK_TOLERANCE_SECONDS) return false;

  const received = Buffer.from(signature, 'hex');
  const expected = Buffer.from(computeWebhookSignature(secret, timestamp, rawBody), 'hex');
  if (received.length !== expected.length) return false;
  return timingSafeEqual(received, expected);
}

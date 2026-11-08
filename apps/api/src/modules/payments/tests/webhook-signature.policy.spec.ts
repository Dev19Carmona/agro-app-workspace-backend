import {
  computeWebhookSignature,
  verifyWebhookSignature,
} from '../policies/webhook-signature.policy.js';

const secret = 'x'.repeat(32);
const now = 1_800_000_000;
const body = '{"eventId":"e","resultado":"APPROVED"}';
const ts = String(now);
const base = () => ({
  secret,
  timestamp: ts,
  rawBody: body,
  signature: computeWebhookSignature(secret, ts, body),
  now,
});

describe('webhook-signature.policy', () => {
  it('acepta una firma válida (string y Buffer)', () => {
    expect(verifyWebhookSignature(base())).toBe(true);
    expect(verifyWebhookSignature({ ...base(), rawBody: Buffer.from(body) })).toBe(true);
  });

  it('acepta la firma en mayúsculas', () => {
    const b = base();
    expect(verifyWebhookSignature({ ...b, signature: b.signature.toUpperCase() })).toBe(true);
  });

  it('rechaza una firma alterada', () => {
    const b = base();
    const flipped = (b.signature[0] === 'a' ? 'b' : 'a') + b.signature.slice(1);
    expect(verifyWebhookSignature({ ...b, signature: flipped })).toBe(false);
  });

  it('rechaza un cuerpo alterado o un secreto distinto', () => {
    expect(verifyWebhookSignature({ ...base(), rawBody: body + ' ' })).toBe(false);
    expect(verifyWebhookSignature({ ...base(), secret: 'y'.repeat(32) })).toBe(false);
  });

  it('el timestamp va firmado: otra hora con la misma firma falla', () => {
    expect(verifyWebhookSignature({ ...base(), timestamp: String(now + 1) })).toBe(false);
  });

  it.each([300, -300])('acepta el timestamp a %i s', (delta) => {
    const t = String(now + delta);
    expect(
      verifyWebhookSignature({ ...base(), timestamp: t, signature: computeWebhookSignature(secret, t, body) }),
    ).toBe(true);
  });

  it.each([301, -301])('rechaza el timestamp a %i s', (delta) => {
    const t = String(now + delta);
    expect(
      verifyWebhookSignature({ ...base(), timestamp: t, signature: computeWebhookSignature(secret, t, body) }),
    ).toBe(false);
  });

  it('rechaza headers ausentes', () => {
    expect(verifyWebhookSignature({ ...base(), timestamp: undefined })).toBe(false);
    expect(verifyWebhookSignature({ ...base(), signature: undefined })).toBe(false);
    expect(verifyWebhookSignature({ ...base(), timestamp: '' })).toBe(false);
    expect(verifyWebhookSignature({ ...base(), signature: '' })).toBe(false);
  });

  it.each(['abc', '12.5', '-1', '1e9', ' 123'])('rechaza el timestamp no entero %j', (t) => {
    expect(verifyWebhookSignature({ ...base(), timestamp: t })).toBe(false);
  });

  it('rechaza firmas no hexadecimales o de longitud distinta', () => {
    const b = base();
    expect(verifyWebhookSignature({ ...b, signature: b.signature.slice(0, 62) })).toBe(false);
    expect(verifyWebhookSignature({ ...b, signature: b.signature + '00' })).toBe(false);
    expect(verifyWebhookSignature({ ...b, signature: 'z'.repeat(64) })).toBe(false);
  });
});

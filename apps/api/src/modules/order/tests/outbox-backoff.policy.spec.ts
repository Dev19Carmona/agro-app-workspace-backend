import {
  backoffMs,
  isExhausted,
  MAX_OUTBOX_ATTEMPTS,
} from '../policies/outbox-backoff.policy.js';

describe('outbox-backoff.policy', () => {
  it('crece de forma exponencial desde 2 s', () => {
    expect(backoffMs(1)).toBe(4_000);
    expect(backoffMs(2)).toBe(8_000);
    expect(backoffMs(3)).toBe(16_000);
    expect(backoffMs(4)).toBe(32_000);
  });

  it('tiene tope de 60 s', () => {
    expect(backoffMs(5)).toBe(60_000);
    expect(backoffMs(20)).toBe(60_000);
  });

  it('se agota al llegar a 5 intentos', () => {
    expect(MAX_OUTBOX_ATTEMPTS).toBe(5);
    expect(isExhausted(4)).toBe(false);
    expect(isExhausted(5)).toBe(true);
  });
});

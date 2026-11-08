import {
  randomLatencyMs,
  resolveGatewayOutcome,
} from '../policies/gateway-token.policy.js';

describe('gateway-token.policy', () => {
  it.each([
    ['tok_test_approved', { resultado: 'APPROVED' }],
    ['tok_test_declined', { resultado: 'DECLINED', motivo: 'INSUFFICIENT_FUNDS' }],
    ['tok_test_error', { resultado: 'ERROR', motivo: 'GATEWAY_ERROR' }],
    ['tok_test_pending', { resultado: 'PROCESSING' }],
  ])('token %s', (token, esperado) => {
    expect(resolveGatewayOutcome(token)).toEqual(esperado);
  });

  it.each(['tok_raro', '', 'TOK_TEST_APPROVED', 'tok_test_approved '])(
    'token desconocido %j → DECLINED INVALID_TOKEN',
    (token) => {
      expect(resolveGatewayOutcome(token)).toEqual({
        resultado: 'DECLINED',
        motivo: 'INVALID_TOKEN',
      });
    },
  );

  it('la latencia está en los extremos y siempre entre 1000 y 3000', () => {
    expect(randomLatencyMs(() => 0)).toBe(1000);
    expect(randomLatencyMs(() => 0.999999)).toBe(3000);
    for (let i = 0; i < 1000; i++) {
      const ms = randomLatencyMs();
      expect(Number.isInteger(ms)).toBe(true);
      expect(ms).toBeGreaterThanOrEqual(1000);
      expect(ms).toBeLessThanOrEqual(3000);
    }
  });
});

import { computeRequestHash } from '../policies/request-hash.policy.js';

const base = { orderId: '665f1c2e8b3a4d0012345678', metodo: 'CARD', token: 'tok_test_approved' };

describe('request-hash.policy', () => {
  it('es SHA-256 hexadecimal y estable', () => {
    const h = computeRequestHash(base);
    expect(h).toMatch(/^[0-9a-f]{64}$/);
    expect(computeRequestHash({ ...base })).toBe(h);
  });

  it.each([
    { token: 'tok_test_declined' },
    { metodo: 'PSE' },
    { orderId: '665f1c2e8b3a4d0012345679' },
  ])('cambia si varía %o', (cambio) => {
    expect(computeRequestHash({ ...base, ...cambio })).not.toBe(computeRequestHash(base));
  });

  it('no contiene el token en claro', () => {
    expect(computeRequestHash(base)).not.toContain('tok_test');
  });
});

import {
  sanitizeForTransport,
  UnsupportedEventTypeError,
} from '../policies/event-sanitizer.policy.js';

describe('event-sanitizer.policy', () => {
  it('provider.approved deja solo userId y reviewedBy', () => {
    expect(
      sanitizeForTransport('provider.approved', {
        userId: 'u1',
        reviewedBy: 'a1',
        email: 'x@y.co',
        otro: 1,
      }),
    ).toEqual({ userId: 'u1', reviewedBy: 'a1' });
  });

  it('descarta email aunque sea el único campo extra', () => {
    const out = sanitizeForTransport('provider.approved', {
      userId: 'u1',
      email: 'x@y.co',
    });
    expect(out).not.toHaveProperty('email');
    expect(out).toEqual({ userId: 'u1' });
  });

  it.each([
    [
      'user.registered',
      { userId: 'u', rol: 'PROVEEDOR', status: 'PENDING_APPROVAL' },
    ],
    [
      'provider.rejected',
      { userId: 'u', reviewedBy: 'a', reason: 'Falta RUT' },
    ],
    [
      'payment.approved',
      { orderId: 'o', paymentId: 'p', buyerId: 'b', monto: 5 },
    ],
    ['payment.declined', { orderId: 'o', paymentId: 'p', buyerId: 'b' }],
    [
      'order.confirmed',
      { orderId: 'o', buyerId: 'b', total: 5, storeIds: ['s1', 's2'] },
    ],
    ['order.cancelled', { orderId: 'o', buyerId: 'b', motivo: 'EXPIRED' }],
  ])(
    '%s conserva solo sus campos y descarta email y desconocidos',
    (type, ok) => {
      expect(
        sanitizeForTransport(type, { ...ok, email: 'x@y.co', otro: 1 }),
      ).toEqual(ok);
    },
  );

  it('payment.declined no deja salir el motivo', () => {
    expect(
      sanitizeForTransport('payment.declined', {
        orderId: 'o',
        paymentId: 'p',
        buyerId: 'b',
        motivo: 'FONDOS',
      }),
    ).not.toHaveProperty('motivo');
  });

  it.each(['order.created', 'stock.reserved', 'store.created'])(
    'rechaza %s (sin entrada)',
    (type) => {
      expect(() => sanitizeForTransport(type, { a: 1 })).toThrow(
        UnsupportedEventTypeError,
      );
    },
  );

  it('rechaza nombres heredados de Object.prototype', () => {
    expect(() => sanitizeForTransport('constructor', {})).toThrow(
      UnsupportedEventTypeError,
    );
  });
});

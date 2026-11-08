import {
  canTransition,
  isFinal,
  type OrderStatus,
} from '../policies/order-state.policy.js';

describe('order-state.policy', () => {
  it.each<[OrderStatus, OrderStatus]>([
    ['PENDING', 'AWAITING_PAYMENT'],
    ['PENDING', 'CANCELLED'],
    ['AWAITING_PAYMENT', 'CONFIRMED'],
    ['AWAITING_PAYMENT', 'CANCELLED'],
  ])('permite %s → %s', (from, to) => {
    expect(canTransition(from, to)).toBe(true);
  });

  it.each<[OrderStatus, OrderStatus]>([
    ['PENDING', 'CONFIRMED'],
    ['PENDING', 'PENDING'],
    ['AWAITING_PAYMENT', 'PENDING'],
    ['CONFIRMED', 'CANCELLED'],
    ['CONFIRMED', 'AWAITING_PAYMENT'],
    ['CANCELLED', 'CONFIRMED'],
    ['CANCELLED', 'PENDING'],
  ])('rechaza %s → %s', (from, to) => {
    expect(canTransition(from, to)).toBe(false);
  });

  it('CONFIRMED y CANCELLED son finales', () => {
    expect(isFinal('CONFIRMED')).toBe(true);
    expect(isFinal('CANCELLED')).toBe(true);
    expect(isFinal('PENDING')).toBe(false);
    expect(isFinal('AWAITING_PAYMENT')).toBe(false);
  });
});

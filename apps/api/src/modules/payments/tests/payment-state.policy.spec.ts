import {
  canTransition,
  isFinal,
  type PaymentStatus,
} from '../policies/payment-state.policy.js';

describe('payment-state.policy', () => {
  it.each<[PaymentStatus, PaymentStatus]>([
    ['PENDING', 'PROCESSING'],
    ['PROCESSING', 'APPROVED'],
    ['PROCESSING', 'DECLINED'],
    ['PROCESSING', 'ERROR'],
  ])('permite %s → %s', (from, to) => {
    expect(canTransition(from, to)).toBe(true);
  });

  it.each<[PaymentStatus, PaymentStatus]>([
    ['PENDING', 'APPROVED'],
    ['PENDING', 'DECLINED'],
    ['PENDING', 'PENDING'],
    ['PROCESSING', 'PENDING'],
    ['PROCESSING', 'PROCESSING'],
    ['APPROVED', 'DECLINED'],
    ['DECLINED', 'APPROVED'],
    ['ERROR', 'PROCESSING'],
  ])('rechaza %s → %s', (from, to) => {
    expect(canTransition(from, to)).toBe(false);
  });

  it('los estados finales no cambian', () => {
    const all: PaymentStatus[] = ['PENDING', 'PROCESSING', 'APPROVED', 'DECLINED', 'ERROR'];
    for (const final of ['APPROVED', 'DECLINED', 'ERROR'] as const) {
      expect(isFinal(final)).toBe(true);
      for (const to of all) expect(canTransition(final, to)).toBe(false);
    }
    expect(isFinal('PENDING')).toBe(false);
    expect(isFinal('PROCESSING')).toBe(false);
  });
});

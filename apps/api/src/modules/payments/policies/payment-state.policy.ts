/** Reglas puras de transición de estado del pago (sin Nest). */

export type PaymentStatus =
  'PENDING' | 'PROCESSING' | 'APPROVED' | 'DECLINED' | 'ERROR';

const ALLOWED: Record<PaymentStatus, readonly PaymentStatus[]> = {
  PENDING: ['PROCESSING'],
  PROCESSING: ['APPROVED', 'DECLINED', 'ERROR'],
  APPROVED: [],
  DECLINED: [],
  ERROR: [],
};

/** `true` si el pago puede pasar de `from` a `to`. */
export function canTransition(from: PaymentStatus, to: PaymentStatus): boolean {
  return ALLOWED[from].includes(to);
}

/** `APPROVED`, `DECLINED` y `ERROR` son finales. */
export function isFinal(status: PaymentStatus): boolean {
  return ALLOWED[status].length === 0;
}

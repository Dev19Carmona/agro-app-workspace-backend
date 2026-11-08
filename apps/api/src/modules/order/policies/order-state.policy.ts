/** Reglas puras de transición de estado del pedido (sin Nest). */

export type OrderStatus =
  'PENDING' | 'AWAITING_PAYMENT' | 'CONFIRMED' | 'CANCELLED';

const ALLOWED: Record<OrderStatus, readonly OrderStatus[]> = {
  PENDING: ['AWAITING_PAYMENT', 'CANCELLED'],
  AWAITING_PAYMENT: ['CONFIRMED', 'CANCELLED'],
  CONFIRMED: [],
  CANCELLED: [],
};

/** `true` si el pedido puede pasar de `from` a `to`. */
export function canTransition(from: OrderStatus, to: OrderStatus): boolean {
  return ALLOWED[from].includes(to);
}

/** `CONFIRMED` y `CANCELLED` son finales. */
export function isFinal(status: OrderStatus): boolean {
  return ALLOWED[status].length === 0;
}

/**
 * Lista blanca de campos que salen del monolito hacia RabbitMQ (sin Nest).
 * Un campo nuevo en un evento de dominio no sale hasta que se añada aquí.
 * Los eventos no llevan datos personales (p. ej. `email`).
 */

const ALLOWED_FIELDS: Readonly<Record<string, readonly string[]>> = {
  'user.registered': ['userId', 'rol', 'status'],
  'provider.approved': ['userId', 'reviewedBy'],
  'provider.rejected': ['userId', 'reviewedBy', 'reason'],
  'payment.approved': ['orderId', 'paymentId', 'buyerId', 'monto'],
  'payment.declined': ['orderId', 'paymentId', 'buyerId'],
  'order.confirmed': ['orderId', 'buyerId', 'total', 'storeIds'],
  'order.cancelled': ['orderId', 'buyerId', 'motivo'],
};

export class UnsupportedEventTypeError extends Error {
  constructor(type: string) {
    super(`El tipo de evento "${type}" no tiene lista blanca y no se publica`);
    this.name = 'UnsupportedEventTypeError';
  }
}

/** Devuelve solo los campos permitidos para `type`; un tipo sin entrada se rechaza. */
export function sanitizeForTransport(
  type: string,
  payload: Record<string, unknown>,
): Record<string, unknown> {
  const allowed = Object.hasOwn(ALLOWED_FIELDS, type)
    ? ALLOWED_FIELDS[type]
    : undefined;
  if (!allowed) {
    throw new UnsupportedEventTypeError(type);
  }
  return Object.fromEntries(
    allowed.filter((field) => field in payload).map((f) => [f, payload[f]]),
  );
}

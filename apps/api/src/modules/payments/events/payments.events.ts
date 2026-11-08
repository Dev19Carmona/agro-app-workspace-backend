/** Eventos de dominio que emite `payments` (en memoria, con reemisión). */
export const PaymentEvents = {
  PaymentApproved: 'payment.approved',
  PaymentDeclined: 'payment.declined',
} as const;

// Payloads fijados por el spec 07; se reexportan desde la API pública de `order`.
export type {
  PaymentApprovedPayload,
  PaymentDeclinedPayload,
} from '../../order/index.js';

/** Eventos de dominio que emite `order` (solo vía outbox). */
export const OrderEvents = {
  OrderCreated: 'order.created',
  OrderConfirmed: 'order.confirmed',
  OrderCancelled: 'order.cancelled',
} as const;

/** Eventos de `payments` que `order` consume; `stock.*` vienen de `CatalogEvents`. */
export const ConsumedEvents = {
  PaymentApproved: 'payment.approved',
  PaymentDeclined: 'payment.declined',
} as const;

export type OrderCreatedPayload = {
  orderId: string;
  items: { variantId: string; cantidad: number }[]; // contrato mínimo del spec 06
  buyerId: string;
  total: number;
};
export type OrderConfirmedPayload = {
  orderId: string;
  buyerId: string;
  total: number;
  /** Tiendas del pedido (ObjectId en hex, sin repetidos, al menos una). */
  storeIds: string[];
};
export type OrderCancelledPayload = {
  orderId: string;
  buyerId: string;
  motivo: 'STOCK_REJECTED' | 'EXPIRED' | 'STOCK_TIMEOUT' | 'LATE_RESERVATION';
};

export type PaymentApprovedPayload = {
  orderId: string;
  paymentId: string;
  buyerId: string;
  monto: number;
};
export type PaymentDeclinedPayload = {
  orderId: string;
  paymentId: string;
  buyerId: string;
  motivo: string;
};

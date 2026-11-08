/** Sobre común de los eventos de la saga; `correlationId` es el id del pedido. */
export type DomainEvent<TType extends string, TPayload> = {
  eventId: string; // uuid v4
  type: TType;
  occurredAt: string; // ISO 8601
  correlationId: string; // id del pedido
  payload: TPayload;
};

/** Nombres de los eventos de dominio que emite `catalog` (en memoria). */
export const CatalogEvents = {
  StoreCreated: 'store.created',
  StockReserved: 'stock.reserved',
  StockRejected: 'stock.rejected',
  StockReleased: 'stock.released',
} as const;

/** Eventos que `catalog` consume (los emite `order`). */
export const ConsumedOrderEvents = {
  OrderCreated: 'order.created',
  OrderConfirmed: 'order.confirmed',
  OrderCancelled: 'order.cancelled',
} as const;

export type StockItem = { variantId: string; cantidad: number };

export type OrderCreatedPayload = { orderId: string; items: StockItem[] };
export type OrderConfirmedPayload = { orderId: string };
export type OrderCancelledPayload = { orderId: string };

/** Evento interno sin sobre (como los de `auth`): no pertenece a la saga. */
export type StoreCreatedEvent = { storeId: string; ownerId: string };

export type StockReservedPayload = { orderId: string; items: StockItem[] };
export type StockRejectedPayload = {
  orderId: string;
  motivo: 'INSUFFICIENT_STOCK' | 'VARIANT_UNAVAILABLE';
  /** Solo las que fallaron. */
  items: (StockItem & { disponible: number })[];
};
export type StockReleasedPayload = { orderId: string; items: StockItem[] };

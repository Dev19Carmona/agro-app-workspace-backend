export { CatalogModule } from './catalog.module.js';
export { CatalogQueryService } from './services/catalog-query.service.js';
export {
  CatalogEvents,
  ConsumedOrderEvents,
  type StoreCreatedEvent,
  type StockReservedPayload,
  type StockRejectedPayload,
  type StockReleasedPayload,
  type OrderCreatedPayload,
  type OrderConfirmedPayload,
  type OrderCancelledPayload,
  type DomainEvent,
} from './events/catalog.events.js';
export type { CheckoutVariant } from './services/catalog-query.service.js';

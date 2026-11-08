export { OrderModule } from './order.module.js';
export { OrderQueryService } from './services/order-query.service.js';
export type { OrderForPayment } from './services/order-query.service.js';
export {
  OrderEvents,
  ConsumedEvents,
  type OrderCreatedPayload,
  type OrderConfirmedPayload,
  type OrderCancelledPayload,
  type PaymentApprovedPayload,
  type PaymentDeclinedPayload,
} from './events/order.events.js';
export type { DomainEvent } from '../catalog/index.js';

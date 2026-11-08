import { Injectable } from '@nestjs/common';
import { OnEvent } from '@nestjs/event-emitter';
import {
  ConsumedOrderEvents,
  type DomainEvent,
  type OrderCancelledPayload,
  type OrderConfirmedPayload,
  type OrderCreatedPayload,
} from '../events/catalog.events.js';
import { StockService } from './stock.service.js';

/** Consume los eventos `order.*` de la saga y delega en `StockService`. */
@Injectable()
export class StockListenerService {
  constructor(private readonly stock: StockService) {}

  @OnEvent(ConsumedOrderEvents.OrderCreated)
  async handleOrderCreated(
    event: DomainEvent<'order.created', OrderCreatedPayload>,
  ): Promise<void> {
    await this.stock.reserve(event);
  }

  @OnEvent(ConsumedOrderEvents.OrderConfirmed)
  async handleOrderConfirmed(
    event: DomainEvent<'order.confirmed', OrderConfirmedPayload>,
  ): Promise<void> {
    await this.stock.confirm(event);
  }

  @OnEvent(ConsumedOrderEvents.OrderCancelled)
  async handleOrderCancelled(
    event: DomainEvent<'order.cancelled', OrderCancelledPayload>,
  ): Promise<void> {
    await this.stock.release(event);
  }
}

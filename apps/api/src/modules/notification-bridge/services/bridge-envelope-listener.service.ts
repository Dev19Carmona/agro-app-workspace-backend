import { Injectable, Logger } from '@nestjs/common';
import { OnEvent } from '@nestjs/event-emitter';
import { InjectModel } from '@nestjs/mongoose';
import type { Model } from 'mongoose';
import { type DomainEvent, OrderEvents } from '../../order/index.js';
import { PaymentEvents } from '../../payments/index.js';
import {
  NotificationOutboxEvent,
  type NotificationOutboxEventDocument,
} from '../schemas/notification-outbox.schema.js';
import { enqueueNotificationEvent } from './outbox-enqueue.js';

type Envelope = DomainEvent<string, Record<string, unknown>>;

/**
 * Escucha los eventos de `order` y `payments`, que ya traen el sobre
 * `DomainEvent`, y reutiliza su `eventId`: un reenvío del outbox de `order` o de
 * la reemisión de `payments` no duplica nada. Se emiten con `emitAsync`, así que
 * relanzar un error hace que el origen reintente.
 */
@Injectable()
export class BridgeEnvelopeListenerService {
  private readonly logger = new Logger(BridgeEnvelopeListenerService.name);

  constructor(
    @InjectModel(NotificationOutboxEvent.name)
    private readonly outboxModel: Model<NotificationOutboxEventDocument>,
  ) {}

  @OnEvent(PaymentEvents.PaymentApproved)
  onPaymentApproved(event: Envelope): Promise<void> {
    return this.enqueue(event);
  }

  @OnEvent(PaymentEvents.PaymentDeclined)
  onPaymentDeclined(event: Envelope): Promise<void> {
    return this.enqueue(event);
  }

  @OnEvent(OrderEvents.OrderConfirmed)
  onOrderConfirmed(event: Envelope): Promise<void> {
    return this.enqueue(event);
  }

  @OnEvent(OrderEvents.OrderCancelled)
  onOrderCancelled(event: Envelope): Promise<void> {
    return this.enqueue(event);
  }

  private enqueue(event: Envelope): Promise<void> {
    return enqueueNotificationEvent(this.outboxModel, this.logger, {
      eventId: event.eventId,
      type: event.type,
      correlationId: event.correlationId,
      occurredAt: new Date(event.occurredAt),
      payload: event.payload,
    });
  }
}

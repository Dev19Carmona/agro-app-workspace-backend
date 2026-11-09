import { randomUUID } from 'node:crypto';
import { Injectable, Logger } from '@nestjs/common';
import { OnEvent } from '@nestjs/event-emitter';
import { InjectModel } from '@nestjs/mongoose';
import type { Model } from 'mongoose';
import {
  AuthEvents,
  type ProviderApprovedEvent,
  type ProviderRejectedEvent,
  type UserRegisteredEvent,
} from '../../auth/index.js';
import {
  NotificationOutboxEvent,
  type NotificationOutboxEventDocument,
} from '../schemas/notification-outbox.schema.js';
import { enqueueNotificationEvent } from './outbox-enqueue.js';

/**
 * Escucha los eventos en memoria de `auth` (sin sobre) y los guarda en
 * `notification_outbox` con un `eventId` nuevo y la lista blanca aplicada.
 *
 * `auth` emite con `emit` (sin esperar listeners): si el insert falla, el aviso se pierde.
 * Riesgo aceptado en el spec 09; se registra un `error` sin payload.
 */
@Injectable()
export class BridgeListenerService {
  private readonly logger = new Logger(BridgeListenerService.name);

  constructor(
    @InjectModel(NotificationOutboxEvent.name)
    private readonly outboxModel: Model<NotificationOutboxEventDocument>,
  ) {}

  @OnEvent(AuthEvents.UserRegistered)
  async onUserRegistered(event: UserRegisteredEvent): Promise<void> {
    await this.enqueue(AuthEvents.UserRegistered, event.userId, { ...event });
  }

  @OnEvent(AuthEvents.ProviderApproved)
  async onProviderApproved(event: ProviderApprovedEvent): Promise<void> {
    await this.enqueue(AuthEvents.ProviderApproved, event.userId, { ...event });
  }

  @OnEvent(AuthEvents.ProviderRejected)
  async onProviderRejected(event: ProviderRejectedEvent): Promise<void> {
    await this.enqueue(AuthEvents.ProviderRejected, event.userId, { ...event });
  }

  private enqueue(
    type: string,
    correlationId: string,
    payload: Record<string, unknown>,
  ): Promise<void> {
    return enqueueNotificationEvent(this.outboxModel, this.logger, {
      eventId: randomUUID(),
      type,
      correlationId,
      payload,
      occurredAt: new Date(),
    });
  }
}

import { randomUUID } from 'node:crypto';
import { Injectable, Logger } from '@nestjs/common';
import { OnEvent } from '@nestjs/event-emitter';
import { InjectModel } from '@nestjs/mongoose';
import type { Model } from 'mongoose';
import { AuthEvents, type ProviderApprovedEvent } from '../../auth/index.js';
import { sanitizeForTransport } from '../policies/event-sanitizer.policy.js';
import {
  NotificationOutboxEvent,
  type NotificationOutboxEventDocument,
} from '../schemas/notification-outbox.schema.js';

const isDuplicateKeyError = (error: unknown): boolean =>
  typeof error === 'object' &&
  error !== null &&
  (error as { code?: unknown }).code === 11000;

/**
 * Escucha los eventos en memoria de dominio y los guarda en `notification_outbox`
 * (sobre nuevo + lista blanca) para que el publicador los envíe a RabbitMQ.
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

  @OnEvent(AuthEvents.ProviderApproved)
  async onProviderApproved(event: ProviderApprovedEvent): Promise<void> {
    await this.enqueue(AuthEvents.ProviderApproved, event.userId, { ...event });
  }

  private async enqueue(
    type: string,
    correlationId: string,
    payload: Record<string, unknown>,
  ): Promise<void> {
    const eventId = randomUUID();
    try {
      await this.outboxModel.create({
        eventId,
        type,
        correlationId,
        payload: sanitizeForTransport(type, payload),
        occurredAt: new Date(),
      });
    } catch (error) {
      if (isDuplicateKeyError(error)) {
        return; // reenvío del mismo eventId
      }
      // Sin payload ni mensaje del error: pueden traer datos personales.
      this.logger.error(
        `No se pudo guardar el evento ${type} (${eventId}) en el outbox: ${(error as Error).name}`,
      );
      throw error;
    }
  }
}

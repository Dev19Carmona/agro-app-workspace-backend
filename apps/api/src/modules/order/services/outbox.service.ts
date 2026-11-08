import { randomUUID } from 'node:crypto';
import { Injectable } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import type { ClientSession, Model } from 'mongoose';
import {
  OutboxEvent,
  type OutboxEventDocument,
  OutboxStatus,
} from '../schemas/outbox-event.schema.js';

export type OutboxEventType = OutboxEvent['type'];

/**
 * Alta de eventos `order.*` en `outbox_events`. Es la única forma en que
 * `order` produce esos eventos: los publica `OutboxPublisherService`.
 */
@Injectable()
export class OutboxService {
  constructor(
    @InjectModel(OutboxEvent.name)
    private readonly outboxModel: Model<OutboxEventDocument>,
  ) {}

  /**
   * Inserta el evento `PENDING` dentro de la transacción recibida, de modo que
   * se confirme o se aborte junto con el cambio de estado del pedido.
   * Devuelve el `eventId` (uuid v4).
   */
  async add(
    session: ClientSession,
    type: OutboxEventType,
    orderId: string,
    payload: Record<string, unknown>,
  ): Promise<string> {
    const eventId = randomUUID();
    await this.outboxModel.create(
      [
        {
          eventId,
          type,
          correlationId: orderId,
          payload,
          occurredAt: new Date(),
          status: OutboxStatus.PENDING,
          attempts: 0,
          nextAttemptAt: new Date(),
        },
      ],
      { session },
    );
    return eventId;
  }
}

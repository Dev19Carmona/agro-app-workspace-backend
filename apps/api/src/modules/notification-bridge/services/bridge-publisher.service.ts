import { Inject, Injectable, Logger } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Interval } from '@nestjs/schedule';
import type { Model, Types } from 'mongoose';
import type { WireEvent } from '../../../../../../libs/common/src/messaging/domain-event.schema.js';
import { backoffMs, isExhausted } from '../policies/publish-backoff.policy.js';
import {
  NotificationOutboxEvent,
  type NotificationOutboxEventDocument,
  NotificationOutboxStatus,
} from '../schemas/notification-outbox.schema.js';
import { EVENT_PUBLISHER, type EventPublisher } from './event-publisher.js';

export const BRIDGE_INTERVAL_MS = 2_000;
/** Un evento reclamado no se vuelve a reclamar hasta pasado este plazo. */
export const BRIDGE_LOCK_MS = 30_000;
/** Tope de eventos por ciclo, para que un ciclo no se alargue sin límite. */
const MAX_PER_CYCLE = 100;
const MAX_ERROR_LENGTH = 500;

/**
 * Publica en RabbitMQ los eventos guardados en `notification_outbox`.
 * Entrega al menos una vez: `notifications` es idempotente por `eventId`.
 */
@Injectable()
export class BridgePublisherService {
  private readonly logger = new Logger(BridgePublisherService.name);
  /** Un ciclo no se solapa con el anterior (una sola instancia). */
  private running = false;

  constructor(
    @InjectModel(NotificationOutboxEvent.name)
    private readonly outboxModel: Model<NotificationOutboxEventDocument>,
    @Inject(EVENT_PUBLISHER) private readonly publisher: EventPublisher,
  ) {}

  @Interval(BRIDGE_INTERVAL_MS)
  async publishPending(): Promise<void> {
    if (this.running) return;
    this.running = true;
    try {
      for (let i = 0; i < MAX_PER_CYCLE; i++) {
        if (!this.publisher.isConnected()) {
          // Una caída del broker no consume los intentos de los eventos.
          this.logger.warn(
            'RabbitMQ sin conexión: se salta el ciclo del puente',
          );
          break;
        }
        if (!(await this.publishNext())) break;
      }
    } catch (error) {
      this.logger.error(`Ciclo del puente falló: ${errorMessage(error)}`);
    } finally {
      this.running = false;
    }
  }

  /** Reclama y publica un evento. `false` si no había ninguno disponible. */
  private async publishNext(): Promise<boolean> {
    const now = new Date();
    const event = await this.outboxModel
      .findOneAndUpdate(
        {
          status: NotificationOutboxStatus.PENDING,
          nextAttemptAt: { $lte: now },
          $or: [
            { lockedUntil: { $exists: false } },
            { lockedUntil: { $lte: now } },
          ],
        },
        { $set: { lockedUntil: new Date(now.getTime() + BRIDGE_LOCK_MS) } },
        { sort: { occurredAt: 1 }, returnDocument: 'after' },
      )
      .lean();
    if (!event) return false;

    const wireEvent: WireEvent = {
      eventId: event.eventId,
      type: event.type,
      occurredAt: event.occurredAt.toISOString(),
      correlationId: event.correlationId,
      payload: event.payload,
    };

    try {
      await this.publisher.publish(wireEvent);
    } catch (error) {
      if (this.publisher.isConnected()) {
        await this.markFailure(event._id, event.attempts + 1, error);
      } else {
        // El broker cayó a mitad de camino: se libera sin gastar un intento.
        await this.release(event._id);
      }
      return true;
    }
    await this.outboxModel.updateOne(
      { _id: event._id },
      {
        $set: {
          status: NotificationOutboxStatus.PUBLISHED,
          publishedAt: new Date(),
        },
        $unset: { lockedUntil: '' },
      },
    );
    return true;
  }

  private async release(id: Types.ObjectId): Promise<void> {
    await this.outboxModel.updateOne(
      { _id: id },
      { $unset: { lockedUntil: '' } },
    );
  }

  private async markFailure(
    id: Types.ObjectId,
    attempts: number,
    error: unknown,
  ): Promise<void> {
    // Solo el mensaje: nunca el payload.
    const lastError = errorMessage(error).slice(0, MAX_ERROR_LENGTH);
    const exhausted = isExhausted(attempts);
    this.logger.warn(
      `Fallo al publicar un evento del puente (intento ${attempts}): ${lastError}`,
    );
    await this.outboxModel.updateOne(
      { _id: id },
      {
        $set: {
          attempts,
          lastError,
          ...(exhausted
            ? { status: NotificationOutboxStatus.FAILED }
            : { nextAttemptAt: new Date(Date.now() + backoffMs(attempts)) }),
        },
        $unset: { lockedUntil: '' },
      },
    );
  }
}

const errorMessage = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);

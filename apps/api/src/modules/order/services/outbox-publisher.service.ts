import { Injectable, Logger } from '@nestjs/common';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { InjectModel } from '@nestjs/mongoose';
import { Interval } from '@nestjs/schedule';
import type { Model, Types } from 'mongoose';
import type { DomainEvent } from '../../catalog/index.js';
import { backoffMs, isExhausted } from '../policies/outbox-backoff.policy.js';
import {
  OutboxEvent,
  type OutboxEventDocument,
  OutboxStatus,
} from '../schemas/outbox-event.schema.js';

export const OUTBOX_INTERVAL_MS = 2_000;
/** Un evento reclamado no se vuelve a reclamar hasta pasado este plazo. */
export const OUTBOX_LOCK_MS = 30_000;
/** Tope de eventos por ciclo, para que un ciclo no se alargue sin límite. */
const MAX_PER_CYCLE = 100;
const MAX_ERROR_LENGTH = 500;

/**
 * Publica en memoria los eventos `order.*` guardados en `outbox_events`.
 * Entrega al menos una vez: los consumidores son idempotentes por `eventId`.
 */
@Injectable()
export class OutboxPublisherService {
  private readonly logger = new Logger(OutboxPublisherService.name);
  /** Un ciclo no se solapa con el anterior (una sola instancia). */
  private running = false;

  constructor(
    @InjectModel(OutboxEvent.name)
    private readonly outboxModel: Model<OutboxEventDocument>,
    private readonly events: EventEmitter2,
  ) {}

  @Interval(OUTBOX_INTERVAL_MS)
  async publishPending(): Promise<void> {
    if (this.running) return;
    this.running = true;
    try {
      for (let i = 0; i < MAX_PER_CYCLE; i++) {
        if (!(await this.publishNext())) break;
      }
    } catch (error) {
      this.logger.error(`Ciclo del outbox falló: ${errorMessage(error)}`);
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
          status: OutboxStatus.PENDING,
          nextAttemptAt: { $lte: now },
          $or: [
            { lockedUntil: { $exists: false } },
            { lockedUntil: { $lte: now } },
          ],
        },
        { $set: { lockedUntil: new Date(now.getTime() + OUTBOX_LOCK_MS) } },
        { sort: { occurredAt: 1 }, returnDocument: 'after' },
      )
      .lean();
    if (!event) return false;

    const envelope: DomainEvent<string, Record<string, unknown>> = {
      eventId: event.eventId,
      type: event.type,
      occurredAt: event.occurredAt.toISOString(),
      correlationId: event.correlationId,
      payload: event.payload,
    };

    try {
      await this.events.emitAsync(event.type, envelope);
    } catch (error) {
      await this.markFailure(event._id, event.attempts + 1, error);
      return true;
    }
    await this.outboxModel.updateOne(
      { _id: event._id },
      { $set: { status: OutboxStatus.PUBLISHED, publishedAt: new Date() } },
    );
    return true;
  }

  private async markFailure(
    id: Types.ObjectId,
    attempts: number,
    error: unknown,
  ): Promise<void> {
    // Solo el mensaje: nunca el payload, que puede traer datos personales.
    const lastError = errorMessage(error).slice(0, MAX_ERROR_LENGTH);
    const exhausted = isExhausted(attempts);
    this.logger.warn(
      `Fallo al publicar un evento del outbox (intento ${attempts}): ${lastError}`,
    );
    await this.outboxModel.updateOne(
      { _id: id },
      {
        $set: {
          attempts,
          lastError,
          ...(exhausted
            ? { status: OutboxStatus.FAILED }
            : { nextAttemptAt: new Date(Date.now() + backoffMs(attempts)) }),
        },
        $unset: { lockedUntil: '' },
      },
    );
  }
}

const errorMessage = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);

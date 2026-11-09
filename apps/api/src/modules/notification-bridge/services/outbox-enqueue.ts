import type { Logger } from '@nestjs/common';
import type { Model } from 'mongoose';
import { sanitizeForTransport } from '../policies/event-sanitizer.policy.js';
import type { NotificationOutboxEventDocument } from '../schemas/notification-outbox.schema.js';

const isDuplicateKeyError = (error: unknown): boolean =>
  typeof error === 'object' &&
  error !== null &&
  (error as { code?: unknown }).code === 11000;

export type OutboxEnvelope = {
  eventId: string;
  type: string;
  correlationId: string;
  occurredAt: Date;
  payload: Record<string, unknown>;
};

/**
 * Guarda el evento en `notification_outbox` aplicando la lista blanca.
 * Un 11000 sobre `eventId` es un reenvío y se ignora; cualquier otro error se
 * registra sin payload (puede traer datos personales) y se relanza.
 */
export async function enqueueNotificationEvent(
  model: Model<NotificationOutboxEventDocument>,
  logger: Logger,
  event: OutboxEnvelope,
): Promise<void> {
  try {
    await model.create({
      ...event,
      payload: sanitizeForTransport(event.type, event.payload),
    });
  } catch (error) {
    if (isDuplicateKeyError(error)) {
      return; // reenvío del mismo eventId
    }
    logger.error(
      `No se pudo guardar el evento ${event.type} (${event.eventId}) en el outbox: ${(error as Error).name}`,
    );
    throw error;
  }
}

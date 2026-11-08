import { Injectable, Logger } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import type { Model } from 'mongoose';
import type { WireEvent } from '../../../../libs/common/src/messaging/domain-event.schema.js';
import {
  Notification,
  type NotificationDocument,
} from '../schemas/notification.schema.js';
import { getTemplate } from '../templates/notification-templates.js';

const isDuplicateKeyError = (error: unknown): boolean =>
  typeof error === 'object' &&
  error !== null &&
  (error as { code?: unknown }).code === 11000;

@Injectable()
export class NotificationsService {
  private readonly logger = new Logger(NotificationsService.name);

  constructor(
    @InjectModel(Notification.name)
    private readonly notificationModel: Model<NotificationDocument>,
  ) {}

  /**
   * Guarda un aviso simulado por cada borrador de la plantilla del evento.
   * Idempotente: un evento repetido choca con el índice único (11000) y no duplica.
   * Lanza si el payload es inválido o si falla Mongo; el consumidor decide el reintento.
   */
  async handle(event: WireEvent): Promise<void> {
    const template = getTemplate(event.type);
    if (!template) {
      throw new Error(`Sin plantilla para el evento ${event.type}`);
    }
    for (const draft of template(event)) {
      try {
        await this.notificationModel.create({
          eventId: event.eventId,
          eventType: event.type,
          correlationId: event.correlationId,
          ...draft,
          canal: 'SIMULATED',
          sentAt: new Date(),
        });
      } catch (error) {
        if (isDuplicateKeyError(error)) continue; // ya procesado
        throw error;
      }
      // Sin el mensaje: solo qué plantilla y a quién.
      this.logger.log(
        `Aviso ${draft.plantilla} para ${draft.destinatarioTipo} ${draft.destinatarioId}`,
      );
    }
  }
}

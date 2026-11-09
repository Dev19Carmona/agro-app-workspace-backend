import { Injectable, NotFoundException } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import type { Model } from 'mongoose';
import { type Actor, actorFilter } from '../policies/actor-filter.policy.js';
import {
  type DestinatarioTipo,
  Notification,
  type NotificationDocument,
  type Plantilla,
} from '../schemas/notification.schema.js';

/** Lo único que sale hacia `api` y, desde ahí, hacia el frontend. */
export type NotificationView = {
  id: string;
  plantilla: Plantilla;
  destinatarioTipo: DestinatarioTipo;
  titulo: string;
  mensaje: string;
  /** Solo en avisos de pagos y pedidos. */
  orderId: string | null;
  sentAt: string;
  readAt: string | null;
};

const ORDER_EVENT_PREFIXES = ['order.', 'payment.'];

/**
 * Arma la vista campo por campo: un campo nuevo en el documento no sale por descuido
 * (no salen `eventId`, `eventType`, `correlationId`, `destinatarioId` ni `canal`).
 */
export function toNotificationView(
  doc: Pick<
    NotificationDocument,
    | '_id'
    | 'plantilla'
    | 'destinatarioTipo'
    | 'titulo'
    | 'mensaje'
    | 'eventType'
    | 'correlationId'
    | 'sentAt'
    | 'readAt'
  >,
): NotificationView {
  const esDePedido = ORDER_EVENT_PREFIXES.some((prefijo) =>
    doc.eventType.startsWith(prefijo),
  );
  return {
    id: String(doc._id),
    plantilla: doc.plantilla,
    destinatarioTipo: doc.destinatarioTipo,
    titulo: doc.titulo,
    mensaje: doc.mensaje,
    orderId: esDePedido ? doc.correlationId : null,
    sentAt: doc.sentAt.toISOString(),
    readAt: doc.readAt ? doc.readAt.toISOString() : null,
  };
}

export type NotificationPage = {
  data: NotificationView[];
  nextCursor: string | null;
};

@Injectable()
export class NotificationsQueryService {
  constructor(
    @InjectModel(Notification.name)
    private readonly notificationModel: Model<NotificationDocument>,
  ) {}

  /**
   * Bandeja del actor, del más nuevo al más viejo (`_id` descendente: equivale al orden de
   * creación). Pide `limit + 1` para saber si hay otra página sin hacer un `count`.
   */
  async list(
    actor: Actor,
    { limit, cursor }: { limit: number; cursor?: string },
  ): Promise<NotificationPage> {
    const docs = await this.notificationModel
      .find({ ...actorFilter(actor), ...(cursor && { _id: { $lt: cursor } }) })
      .sort({ _id: -1 })
      .limit(limit + 1)
      .lean();
    const page = docs.slice(0, limit);
    return {
      data: page.map(toNotificationView),
      nextCursor:
        docs.length > limit ? String(page[page.length - 1]._id) : null,
    };
  }

  async unreadCount(actor: Actor): Promise<{ count: number }> {
    const count = await this.notificationModel.countDocuments({
      ...actorFilter(actor),
      readAt: { $exists: false },
    });
    return { count };
  }

  /**
   * Marca un aviso como leído. Idempotente: si ya estaba leído no mueve `readAt`.
   * Un id ajeno no coincide con el filtro del actor y da 404, igual que uno inexistente.
   */
  async markRead(actor: Actor, id: string): Promise<NotificationView> {
    const filter = { _id: id, ...actorFilter(actor) };
    await this.notificationModel.updateOne(
      { ...filter, readAt: { $exists: false } },
      { $set: { readAt: new Date() } },
    );
    const doc = await this.notificationModel.findOne(filter).lean();
    if (!doc) throw new NotFoundException('Aviso no encontrado');
    return toNotificationView(doc);
  }

  /** Marca como leídos solo los avisos del actor que seguían sin leer. */
  async markAllRead(actor: Actor): Promise<{ updated: number }> {
    const result = await this.notificationModel.updateMany(
      { ...actorFilter(actor), readAt: { $exists: false } },
      { $set: { readAt: new Date() } },
    );
    return { updated: result.modifiedCount };
  }
}

import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { type HydratedDocument, Schema as MongooseSchema } from 'mongoose';

export enum NotificationOutboxStatus {
  PENDING = 'PENDING',
  PUBLISHED = 'PUBLISHED',
  FAILED = 'FAILED',
}

/**
 * Colección `notification_outbox`: eventos ya filtrados por la lista blanca,
 * a la espera de publicarse en RabbitMQ.
 * La clase se llama `NotificationOutboxEvent` porque Mongoose registra los modelos
 * por nombre en la misma conexión y `order` ya tiene `OutboxEvent`.
 */
@Schema({
  collection: 'notification_outbox',
  timestamps: { createdAt: false, updatedAt: false },
})
export class NotificationOutboxEvent {
  /** uuid v4; índice único: hace idempotente el reenvío. */
  @Prop({ type: String, required: true, unique: true })
  eventId: string;

  @Prop({ type: String, required: true })
  type: string;

  /** Id del pedido o, en eventos de auth, el userId. */
  @Prop({ type: String, required: true })
  correlationId: string;

  /** Ya filtrado por la lista blanca. */
  @Prop({ type: MongooseSchema.Types.Mixed, required: true })
  payload: Record<string, unknown>;

  @Prop({ type: Date, required: true })
  occurredAt: Date;

  @Prop({
    type: String,
    enum: Object.values(NotificationOutboxStatus),
    default: NotificationOutboxStatus.PENDING,
  })
  status: NotificationOutboxStatus;

  @Prop({ type: Number, default: 0 })
  attempts: number;

  @Prop({ type: Date, default: () => new Date() })
  nextAttemptAt: Date;

  /** Reclamo del job. */
  @Prop({ type: Date })
  lockedUntil?: Date;

  @Prop({ type: Date })
  publishedAt?: Date;

  /** Sin payload. */
  @Prop({ type: String })
  lastError?: string;
}

export type NotificationOutboxEventDocument =
  HydratedDocument<NotificationOutboxEvent>;
export const NotificationOutboxEventSchema = SchemaFactory.createForClass(
  NotificationOutboxEvent,
);
NotificationOutboxEventSchema.index({ status: 1, nextAttemptAt: 1 });

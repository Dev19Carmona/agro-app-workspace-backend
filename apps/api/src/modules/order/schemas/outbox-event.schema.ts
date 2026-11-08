import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { type HydratedDocument, Schema as MongooseSchema } from 'mongoose';

export enum OutboxStatus {
  PENDING = 'PENDING',
  PUBLISHED = 'PUBLISHED',
  FAILED = 'FAILED',
}

export const OUTBOX_EVENT_TYPES = [
  'order.created',
  'order.confirmed',
  'order.cancelled',
] as const;

/** Colección `outbox_events`: único camino de emisión de `order.*`. */
@Schema({
  collection: 'outbox_events',
  timestamps: { createdAt: false, updatedAt: false },
})
export class OutboxEvent {
  /** uuid v4; índice único. */
  @Prop({ type: String, required: true, unique: true })
  eventId: string;

  @Prop({ type: String, enum: OUTBOX_EVENT_TYPES, required: true })
  type: (typeof OUTBOX_EVENT_TYPES)[number];

  /** Id del pedido. */
  @Prop({ type: String, required: true })
  correlationId: string;

  @Prop({ type: MongooseSchema.Types.Mixed, required: true })
  payload: Record<string, unknown>;

  @Prop({ type: Date, required: true, default: () => new Date() })
  occurredAt: Date;

  @Prop({
    type: String,
    enum: Object.values(OutboxStatus),
    default: OutboxStatus.PENDING,
  })
  status: OutboxStatus;

  @Prop({ type: Number, default: 0 })
  attempts: number;

  @Prop({ type: Date, default: () => new Date() })
  nextAttemptAt: Date;

  /** Reclamo del job. */
  @Prop({ type: Date })
  lockedUntil?: Date;

  @Prop({ type: Date })
  publishedAt?: Date;

  /** Sin datos personales. */
  @Prop({ type: String })
  lastError?: string;
}

export type OutboxEventDocument = HydratedDocument<OutboxEvent>;
export const OutboxEventSchema = SchemaFactory.createForClass(OutboxEvent);
OutboxEventSchema.index({ status: 1, nextAttemptAt: 1 });

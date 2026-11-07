import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import type { HydratedDocument } from 'mongoose';

/** Colección `processed_events`: idempotencia de los consumidores. */
@Schema({
  collection: 'processed_events',
  timestamps: { createdAt: 'processedAt', updatedAt: false },
})
export class ProcessedEvent {
  /** Índice único. */
  @Prop({ type: String, required: true, unique: true })
  eventId: string;

  @Prop({ type: String, required: true })
  type: string;

  processedAt: Date;
}

export type ProcessedEventDocument = HydratedDocument<ProcessedEvent>;
export const ProcessedEventSchema =
  SchemaFactory.createForClass(ProcessedEvent);

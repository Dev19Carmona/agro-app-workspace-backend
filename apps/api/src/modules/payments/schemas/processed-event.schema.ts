import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import type { HydratedDocument } from 'mongoose';

/**
 * Colección `payment_processed_events`: protección contra repetición del
 * webhook. La clase se llama distinto a las de `catalog` y `order` porque
 * Mongoose registra los modelos por nombre en la misma conexión.
 */
@Schema({
  collection: 'payment_processed_events',
  timestamps: { createdAt: 'processedAt', updatedAt: false },
})
export class PaymentProcessedEvent {
  /** `eventId` del webhook; índice único. */
  @Prop({ type: String, required: true, unique: true })
  eventId: string;

  processedAt: Date;
}

export type PaymentProcessedEventDocument =
  HydratedDocument<PaymentProcessedEvent>;
export const PaymentProcessedEventSchema = SchemaFactory.createForClass(
  PaymentProcessedEvent,
);

import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import type { HydratedDocument } from 'mongoose';

/**
 * Colección `order_processed_events`: idempotencia de los consumidores de
 * `order`. La clase se llama distinto a la de `catalog` porque Mongoose
 * registra los modelos por nombre en la misma conexión.
 */
@Schema({
  collection: 'order_processed_events',
  timestamps: { createdAt: 'processedAt', updatedAt: false },
})
export class OrderProcessedEvent {
  /** Índice único. */
  @Prop({ type: String, required: true, unique: true })
  eventId: string;

  @Prop({ type: String, required: true })
  type: string;

  processedAt: Date;
}

export type OrderProcessedEventDocument = HydratedDocument<OrderProcessedEvent>;
export const OrderProcessedEventSchema =
  SchemaFactory.createForClass(OrderProcessedEvent);

import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import {
  type HydratedDocument,
  Schema as MongooseSchema,
  type Types,
} from 'mongoose';

export enum OrderStatus {
  PENDING = 'PENDING',
  AWAITING_PAYMENT = 'AWAITING_PAYMENT',
  CONFIRMED = 'CONFIRMED',
  CANCELLED = 'CANCELLED',
}

export enum CancelReason {
  STOCK_REJECTED = 'STOCK_REJECTED',
  EXPIRED = 'EXPIRED',
  STOCK_TIMEOUT = 'STOCK_TIMEOUT',
}

/** Colección `orders`. `createdAt` marca el inicio de la espera de `catalog`. */
@Schema({ collection: 'orders', timestamps: true })
export class Order {
  @Prop({ type: MongooseSchema.Types.ObjectId, required: true })
  buyerId: Types.ObjectId;

  /** Suma de los subtotales de sus `SubOrder`; entero en COP. */
  @Prop({ type: Number, required: true, min: 0 })
  total: number;

  @Prop({ type: String, enum: ['COP'], default: 'COP' })
  moneda: 'COP';

  @Prop({
    type: String,
    enum: Object.values(OrderStatus),
    default: OrderStatus.PENDING,
  })
  status: OrderStatus;

  /** Se fija al pasar a `AWAITING_PAYMENT`: ahora + 15 min. */
  @Prop({ type: Date })
  expiresAt?: Date;

  /** Header `Idempotency-Key`. */
  @Prop({ type: String, required: true })
  idempotencyKey: string;

  @Prop({ type: String, enum: Object.values(CancelReason) })
  cancelReason?: CancelReason;

  createdAt: Date;
  updatedAt: Date;
}

export type OrderDocument = HydratedDocument<Order>;
export const OrderSchema = SchemaFactory.createForClass(Order);
OrderSchema.index({ buyerId: 1, idempotencyKey: 1 }, { unique: true });
OrderSchema.index({ buyerId: 1, createdAt: -1 });
OrderSchema.index({ status: 1, expiresAt: 1 });
OrderSchema.index({ status: 1, createdAt: 1 });

import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import {
  type HydratedDocument,
  Schema as MongooseSchema,
  type Types,
} from 'mongoose';

export enum ReservationStatus {
  RESERVED = 'RESERVED',
  REJECTED = 'REJECTED',
  CONFIRMED = 'CONFIRMED',
  RELEASED = 'RELEASED',
}

@Schema({ _id: false })
export class ReservationItem {
  @Prop({ type: MongooseSchema.Types.ObjectId, required: true })
  variantId: Types.ObjectId;

  @Prop({ type: Number, required: true, min: 1 })
  cantidad: number;
}
const ReservationItemSchema = SchemaFactory.createForClass(ReservationItem);

/** Colección `stock_reservations`: una por pedido. */
@Schema({ collection: 'stock_reservations', timestamps: true })
export class StockReservation {
  /** `correlationId` de la saga; índice único. */
  @Prop({ type: String, required: true, unique: true })
  orderId: string;

  @Prop({
    type: String,
    enum: Object.values(ReservationStatus),
    required: true,
  })
  status: ReservationStatus;

  @Prop({ type: [ReservationItemSchema], default: [] })
  items: ReservationItem[];

  createdAt: Date;
  updatedAt: Date;
}

export type StockReservationDocument = HydratedDocument<StockReservation>;
export const StockReservationSchema =
  SchemaFactory.createForClass(StockReservation);

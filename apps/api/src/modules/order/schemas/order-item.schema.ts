import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import {
  type HydratedDocument,
  Schema as MongooseSchema,
  type Types,
} from 'mongoose';

/** Colección `order_items`: snapshot del ítem en el checkout. */
@Schema({ collection: 'order_items' })
export class OrderItem {
  @Prop({ type: MongooseSchema.Types.ObjectId, required: true, index: true })
  orderId: Types.ObjectId;

  @Prop({ type: MongooseSchema.Types.ObjectId, required: true })
  subOrderId: Types.ObjectId;

  @Prop({ type: MongooseSchema.Types.ObjectId, required: true })
  variantId: Types.ObjectId;

  @Prop({ type: MongooseSchema.Types.ObjectId, required: true })
  productId: Types.ObjectId;

  @Prop({ type: String, required: true })
  nombreProducto: string;

  @Prop({ type: String, required: true })
  presentacion: string;

  @Prop({ type: String, required: true })
  unidad: string;

  /** `precioVigente` de `catalog` en el checkout. */
  @Prop({ type: Number, required: true, min: 0 })
  precioUnitario: number;

  @Prop({ type: Number, required: true, min: 1 })
  cantidad: number;

  /** `precioUnitario * cantidad`. */
  @Prop({ type: Number, required: true, min: 0 })
  subtotal: number;
}

export type OrderItemDocument = HydratedDocument<OrderItem>;
export const OrderItemSchema = SchemaFactory.createForClass(OrderItem);

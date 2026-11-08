import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import {
  type HydratedDocument,
  Schema as MongooseSchema,
  type Types,
} from 'mongoose';

/** Colección `sub_orders`: un `SubOrder` por tienda del pedido. */
@Schema({
  collection: 'sub_orders',
  timestamps: { createdAt: true, updatedAt: false },
})
export class SubOrder {
  @Prop({ type: MongooseSchema.Types.ObjectId, required: true })
  orderId: Types.ObjectId;

  @Prop({ type: MongooseSchema.Types.ObjectId, required: true })
  storeId: Types.ObjectId;

  @Prop({ type: Number, required: true, min: 0 })
  subtotal: number;

  createdAt: Date;
}

export type SubOrderDocument = HydratedDocument<SubOrder>;
export const SubOrderSchema = SchemaFactory.createForClass(SubOrder);
SubOrderSchema.index({ orderId: 1, storeId: 1 }, { unique: true });
SubOrderSchema.index({ storeId: 1, createdAt: -1 });

import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import {
  type HydratedDocument,
  Schema as MongooseSchema,
  type Types,
} from 'mongoose';

/** Colección `cart_items`: solo la referencia a la variante, sin precio ni nombre. */
@Schema({ collection: 'cart_items', timestamps: true })
export class CartItem {
  @Prop({ type: MongooseSchema.Types.ObjectId, required: true })
  cartId: Types.ObjectId;

  @Prop({ type: MongooseSchema.Types.ObjectId, required: true })
  variantId: Types.ObjectId;

  /** Entero 1..1000. */
  @Prop({ type: Number, required: true, min: 1, max: 1000 })
  cantidad: number;

  createdAt: Date;
  updatedAt: Date;
}

export type CartItemDocument = HydratedDocument<CartItem>;
export const CartItemSchema = SchemaFactory.createForClass(CartItem);
CartItemSchema.index({ cartId: 1, variantId: 1 }, { unique: true });

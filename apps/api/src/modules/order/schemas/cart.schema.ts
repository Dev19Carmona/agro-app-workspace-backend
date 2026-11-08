import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import {
  type HydratedDocument,
  Schema as MongooseSchema,
  type Types,
} from 'mongoose';

/** Colección `carts`: un carrito por PRODUCTOR, sin TTL. */
@Schema({ collection: 'carts', timestamps: true })
export class Cart {
  /** User PRODUCTOR; índice único. */
  @Prop({
    type: MongooseSchema.Types.ObjectId,
    required: true,
    unique: true,
  })
  buyerId: Types.ObjectId;

  createdAt: Date;
  updatedAt: Date;
}

export type CartDocument = HydratedDocument<Cart>;
export const CartSchema = SchemaFactory.createForClass(Cart);

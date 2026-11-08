import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import {
  type HydratedDocument,
  Schema as MongooseSchema,
  type Types,
} from 'mongoose';

const esEntero = (n: number) => Number.isInteger(n);

/** Colección `product_variants`. Precios enteros en COP. */
@Schema({ collection: 'product_variants', timestamps: true })
export class ProductVariant {
  @Prop({ type: MongooseSchema.Types.ObjectId, required: true })
  productId: Types.ObjectId;

  /** p. ej. "4 L". */
  @Prop({ type: String, required: true, trim: true })
  presentacion: string;

  @Prop({
    type: String,
    required: true,
    trim: true,
    minlength: 1,
    maxlength: 20,
  })
  unidad: string;

  @Prop({
    type: Number,
    required: true,
    min: 1,
    validate: { validator: esEntero, message: 'precio debe ser entero' },
  })
  precio: number;

  /** Entero > 0 y menor que `precio`. */
  @Prop({
    type: Number,
    min: 1,
    validate: [
      { validator: esEntero, message: 'precioOferta debe ser entero' },
      {
        validator(this: { precio?: number }, v: number | undefined) {
          return (
            v === undefined || this.precio === undefined || v < this.precio
          );
        },
        message: 'precioOferta debe ser menor que precio',
      },
    ],
  })
  precioOferta?: number;

  @Prop({
    type: Number,
    required: true,
    min: 0,
    validate: { validator: esEntero, message: 'stock debe ser entero' },
  })
  stock: number;

  /** Solo lo cambia la saga. */
  @Prop({ type: Number, default: 0, min: 0 })
  stockReservado: number;

  @Prop({ type: Boolean, default: true })
  activo: boolean;

  createdAt: Date;
  updatedAt: Date;
}

export type ProductVariantDocument = HydratedDocument<ProductVariant>;
export const ProductVariantSchema =
  SchemaFactory.createForClass(ProductVariant);
ProductVariantSchema.index({ productId: 1, activo: 1 });
ProductVariantSchema.index(
  { precioOferta: 1 },
  { partialFilterExpression: { precioOferta: { $exists: true } } },
);

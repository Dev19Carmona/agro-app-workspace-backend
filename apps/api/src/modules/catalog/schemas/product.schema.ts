import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import {
  type HydratedDocument,
  Schema as MongooseSchema,
  type Types,
} from 'mongoose';

export const FICHA_MAX_ENTRADAS = 30;
export const FICHA_MAX_CLAVE = 50;
export const FICHA_MAX_VALOR = 500;

function fichaValida(ficha: Record<string, unknown>): boolean {
  const entradas = Object.entries(ficha);
  return (
    entradas.length <= FICHA_MAX_ENTRADAS &&
    entradas.every(
      ([clave, valor]) =>
        clave.length <= FICHA_MAX_CLAVE &&
        typeof valor === 'string' &&
        valor.length <= FICHA_MAX_VALOR,
    )
  );
}

/** Colección `products`. */
@Schema({ collection: 'products', timestamps: true, minimize: false })
export class Product {
  @Prop({ type: MongooseSchema.Types.ObjectId, required: true })
  storeId: Types.ObjectId;

  @Prop({ type: MongooseSchema.Types.ObjectId, required: true })
  categoryId: Types.ObjectId;

  @Prop({ type: String, required: true, trim: true })
  nombre: string;

  @Prop({ type: String, required: true, trim: true })
  marca: string;

  /** Máx. 30 entradas, clave ≤ 50 y valor ≤ 500 caracteres. */
  @Prop({
    type: Object,
    default: {},
    validate: {
      validator: fichaValida,
      message: 'fichaTecnica fuera de límites',
    },
  })
  fichaTecnica: Record<string, string>;

  /** `true` = se muestra pero queda fuera del checkout. */
  @Prop({ type: Boolean, default: false })
  requiresQuote: boolean;

  @Prop({ type: Boolean, default: true })
  activo: boolean;

  createdAt: Date;
  updatedAt: Date;
}

export type ProductDocument = HydratedDocument<Product>;
export const ProductSchema = SchemaFactory.createForClass(Product);
ProductSchema.index({ storeId: 1, activo: 1 });
ProductSchema.index({ categoryId: 1, activo: 1 });

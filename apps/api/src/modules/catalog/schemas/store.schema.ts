import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import {
  type HydratedDocument,
  Schema as MongooseSchema,
  type Types,
} from 'mongoose';

/** Colección `stores`. Una tienda por PROVEEDOR (índice único en `ownerId`). */
@Schema({ collection: 'stores', timestamps: true })
export class Store {
  @Prop({ type: String, required: true, trim: true })
  nombre: string;

  @Prop({ type: String, required: true, trim: true })
  nit: string;

  /** User PROVEEDOR dueño de la tienda. */
  @Prop({ type: MongooseSchema.Types.ObjectId, required: true, unique: true })
  ownerId: Types.ObjectId;

  @Prop({ type: String, required: true, trim: true })
  municipio: string;

  /** `false` = fuera de la consulta pública y sin productos nuevos. */
  @Prop({ type: Boolean, default: true })
  activa: boolean;

  createdAt: Date;
  updatedAt: Date;
}

export type StoreDocument = HydratedDocument<Store>;
export const StoreSchema = SchemaFactory.createForClass(Store);
StoreSchema.index({ activa: 1, municipio: 1 });

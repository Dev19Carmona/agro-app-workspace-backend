import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import type { HydratedDocument } from 'mongoose';

/** Colección `categories`. */
@Schema({ collection: 'categories', timestamps: true })
export class Category {
  @Prop({ type: String, required: true, trim: true })
  nombre: string;

  @Prop({ type: Boolean, default: true })
  activa: boolean;

  createdAt: Date;
  updatedAt: Date;
}

export type CategoryDocument = HydratedDocument<Category>;
export const CategorySchema = SchemaFactory.createForClass(Category);
/** Nombre único sin distinguir mayúsculas ni tildes (collation `es`, strength 2). */
CategorySchema.index(
  { nombre: 1 },
  { unique: true, collation: { locale: 'es', strength: 2 } },
);

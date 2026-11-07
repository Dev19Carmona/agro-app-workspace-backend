import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { type HydratedDocument, Types } from 'mongoose';

/** Colección `refresh_tokens`. Solo guarda el hash; el token en claro nunca se persiste. */
@Schema({
  collection: 'refresh_tokens',
  timestamps: { createdAt: true, updatedAt: false },
})
export class RefreshToken {
  @Prop({ type: Types.ObjectId, required: true, index: true })
  userId: Types.ObjectId;

  /** uuid que identifica una sesión y todas sus rotaciones. */
  @Prop({ type: String, required: true, index: true })
  familyId: string;

  /** SHA-256 del token opaco. */
  @Prop({ type: String, required: true, unique: true })
  tokenHash: string;

  /** Índice TTL: Mongo borra el documento al llegar esta fecha. */
  @Prop({ type: Date, required: true, expires: 0 })
  expiresAt: Date;

  @Prop({ type: Date })
  revokedAt?: Date;

  /** Token que lo reemplazó al rotar. */
  @Prop({ type: Types.ObjectId })
  replacedBy?: Types.ObjectId;

  createdAt: Date;
}

export type RefreshTokenDocument = HydratedDocument<RefreshToken>;
export const RefreshTokenSchema = SchemaFactory.createForClass(RefreshToken);

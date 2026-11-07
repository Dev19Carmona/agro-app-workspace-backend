import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { type HydratedDocument, Types } from 'mongoose';
import { Role } from '../../../../../../libs/common/src/security/roles.js';

export enum UserStatus {
  ACTIVE = 'ACTIVE',
  PENDING_APPROVAL = 'PENDING_APPROVAL',
  REJECTED = 'REJECTED',
  DISABLED = 'DISABLED',
}

/** Consentimiento de tratamiento de datos (Habeas Data). */
@Schema({ _id: false })
export class Consent {
  @Prop({ type: Date, required: true })
  acceptedAt: Date;

  @Prop({ type: String, required: true })
  version: string;
}
const ConsentSchema = SchemaFactory.createForClass(Consent);

/** Colección `users`. Solo el módulo `auth` la lee o escribe. */
@Schema({ collection: 'users', timestamps: true })
export class User {
  /** Siempre en minúsculas; índice único. */
  @Prop({
    type: String,
    required: true,
    unique: true,
    lowercase: true,
    trim: true,
  })
  email: string;

  /** bcrypt. Fuera de las consultas por defecto: pedirlo con `.select('+passwordHash')`. */
  @Prop({ type: String, required: true, select: false })
  passwordHash: string;

  @Prop({ type: String, required: true, trim: true })
  nombre: string;

  /** Nunca se registra completo en logs. */
  @Prop({ type: String, required: true, trim: true })
  documento: string;

  @Prop({ type: String, enum: Object.values(Role), required: true })
  rol: Role;

  @Prop({
    type: String,
    enum: Object.values(UserStatus),
    required: true,
  })
  status: UserStatus;

  /** Lo asigna `catalog` al crear la tienda; ausente hasta entonces. */
  @Prop({ type: Types.ObjectId })
  storeId?: Types.ObjectId;

  @Prop({ type: ConsentSchema, required: true })
  consent: Consent;

  @Prop({ type: Number, default: 0, min: 0 })
  failedLoginAttempts: number;

  @Prop({ type: Date })
  lockedUntil?: Date;

  @Prop({ type: String })
  rejectionReason?: string;

  /** ADMIN que aprobó o rechazó la solicitud. */
  @Prop({ type: Types.ObjectId })
  reviewedBy?: Types.ObjectId;

  @Prop({ type: Date })
  reviewedAt?: Date;

  @Prop({ type: Date })
  passwordChangedAt?: Date;

  createdAt: Date;
  updatedAt: Date;
}

export type UserDocument = HydratedDocument<User>;
export const UserSchema = SchemaFactory.createForClass(User);

import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import {
  type HydratedDocument,
  Schema as MongooseSchema,
  Types,
} from 'mongoose';

export const DESTINATARIO_TIPOS = ['USER', 'STORE'] as const;
export type DestinatarioTipo = (typeof DESTINATARIO_TIPOS)[number];

export const PLANTILLAS = [
  'USER_REGISTERED',
  'PROVIDER_APPROVED',
  'PROVIDER_REJECTED',
  'PAYMENT_APPROVED',
  'PAYMENT_DECLINED',
  'ORDER_CONFIRMED_BUYER',
  'ORDER_CONFIRMED_STORE',
  'ORDER_CANCELLED',
] as const;
export type Plantilla = (typeof PLANTILLAS)[number];

/** Colección `notifications`: un aviso simulado por evento y destinatario. */
@Schema({
  collection: 'notifications',
  timestamps: { createdAt: true, updatedAt: false },
})
export class Notification {
  /** Evento de origen. */
  @Prop({ type: String, required: true })
  eventId: string;

  @Prop({ type: String, required: true })
  eventType: string;

  @Prop({ type: String, required: true })
  correlationId: string;

  @Prop({ type: String, enum: DESTINATARIO_TIPOS, required: true })
  destinatarioTipo: DestinatarioTipo;

  /** userId o storeId. */
  @Prop({ type: MongooseSchema.Types.ObjectId, required: true })
  destinatarioId: Types.ObjectId;

  @Prop({ type: String, enum: PLANTILLAS, required: true })
  plantilla: Plantilla;

  @Prop({ type: String, required: true })
  titulo: string;

  @Prop({ type: String, required: true })
  mensaje: string;

  @Prop({ type: String, enum: ['SIMULATED'], required: true })
  canal: 'SIMULATED';

  @Prop({ type: Date, required: true })
  sentAt: Date;

  createdAt: Date;
}

export type NotificationDocument = HydratedDocument<Notification>;
export const NotificationSchema = SchemaFactory.createForClass(Notification);
/** Idempotencia del consumidor: un evento repetido produce el mismo documento (error 11000). */
NotificationSchema.index(
  { eventId: 1, destinatarioTipo: 1, destinatarioId: 1 },
  { unique: true },
);
NotificationSchema.index({
  destinatarioTipo: 1,
  destinatarioId: 1,
  createdAt: -1,
});

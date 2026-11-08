import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import {
  type HydratedDocument,
  Schema as MongooseSchema,
  type Types,
} from 'mongoose';

export enum AttemptOrigen {
  SIMULATOR = 'SIMULATOR',
  WEBHOOK = 'WEBHOOK',
}

export enum AttemptResultado {
  APPROVED = 'APPROVED',
  DECLINED = 'DECLINED',
  ERROR = 'ERROR',
  PROCESSING = 'PROCESSING',
}

/** Colección `payment_attempts`: sin token, sin firma, sin cuerpo crudo. */
@Schema({
  collection: 'payment_attempts',
  timestamps: { createdAt: true, updatedAt: false },
})
export class PaymentAttempt {
  @Prop({ type: MongooseSchema.Types.ObjectId, required: true })
  paymentId: Types.ObjectId;

  @Prop({ type: MongooseSchema.Types.ObjectId, required: true })
  orderId: Types.ObjectId;

  @Prop({ type: MongooseSchema.Types.ObjectId, required: true })
  buyerId: Types.ObjectId;

  @Prop({ type: String, enum: Object.values(AttemptOrigen), required: true })
  origen: AttemptOrigen;

  @Prop({
    type: String,
    enum: Object.values(AttemptResultado),
    required: true,
  })
  resultado: AttemptResultado;

  @Prop({ type: String })
  motivo?: string;

  createdAt: Date;
}

export type PaymentAttemptDocument = HydratedDocument<PaymentAttempt>;
export const PaymentAttemptSchema =
  SchemaFactory.createForClass(PaymentAttempt);
PaymentAttemptSchema.index({ paymentId: 1, createdAt: 1 });

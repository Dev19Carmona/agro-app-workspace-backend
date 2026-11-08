import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import {
  type HydratedDocument,
  Schema as MongooseSchema,
  type Types,
} from 'mongoose';

export enum PaymentMetodo {
  CARD = 'CARD',
  PSE = 'PSE',
  NEQUI = 'NEQUI',
}

export enum PaymentStatus {
  PENDING = 'PENDING',
  PROCESSING = 'PROCESSING',
  APPROVED = 'APPROVED',
  DECLINED = 'DECLINED',
  ERROR = 'ERROR',
}

/** Colección `payments`. La idempotencia vive aquí (sin colección aparte ni TTL). */
@Schema({ collection: 'payments', timestamps: true })
export class Payment {
  @Prop({ type: MongooseSchema.Types.ObjectId, required: true })
  orderId: Types.ObjectId;

  /** User PRODUCTOR. */
  @Prop({ type: MongooseSchema.Types.ObjectId, required: true })
  buyerId: Types.ObjectId;

  /** `order.total`, nunca del cliente; entero en COP. */
  @Prop({ type: Number, required: true, min: 0 })
  monto: number;

  @Prop({ type: String, enum: ['COP'], default: 'COP' })
  moneda: 'COP';

  @Prop({ type: String, enum: Object.values(PaymentMetodo), required: true })
  metodo: PaymentMetodo;

  @Prop({
    type: String,
    enum: Object.values(PaymentStatus),
    default: PaymentStatus.PENDING,
  })
  status: PaymentStatus;

  /** La asigna la pasarela: `SIM-<uuid>`. */
  @Prop({ type: String })
  referencia?: string;

  /** `INSUFFICIENT_FUNDS`, `INVALID_TOKEN`, `GATEWAY_ERROR` o el motivo del webhook. */
  @Prop({ type: String })
  motivoRechazo?: string;

  /** Header `Idempotency-Key`. */
  @Prop({ type: String, required: true })
  idempotencyKey: string;

  /** SHA-256 hex de `orderId|metodo|token`; el token nunca se guarda. */
  @Prop({ type: String, required: true })
  requestHash: string;

  /** uuid v4 estable del evento; se fija al pasar a estado final. */
  @Prop({ type: String })
  eventId?: string;

  /** Marca de que `order` procesó la emisión. */
  @Prop({ type: Date })
  eventEmittedAt?: Date;

  /** Intentos de reemisión. */
  @Prop({ type: Number, default: 0, min: 0 })
  eventAttempts: number;

  /** Instante del estado final. */
  @Prop({ type: Date })
  finalizedAt?: Date;

  createdAt: Date;
  updatedAt: Date;
}

export type PaymentDocument = HydratedDocument<Payment>;
export const PaymentSchema = SchemaFactory.createForClass(Payment);
PaymentSchema.index({ buyerId: 1, idempotencyKey: 1 }, { unique: true });
// Un solo pago activo o aprobado por pedido (MongoDB 6.0+ por el `$in`).
PaymentSchema.index(
  { orderId: 1 },
  {
    unique: true,
    partialFilterExpression: {
      status: {
        $in: [
          PaymentStatus.PENDING,
          PaymentStatus.PROCESSING,
          PaymentStatus.APPROVED,
        ],
      },
    },
  },
);
PaymentSchema.index({ buyerId: 1, createdAt: -1 });
PaymentSchema.index({ status: 1, createdAt: -1 });
PaymentSchema.index({ status: 1, eventEmittedAt: 1, finalizedAt: 1 });

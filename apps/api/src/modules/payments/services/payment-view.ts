import type { Types } from 'mongoose';

/** Respuesta pública de un pago: nunca `idempotencyKey`, `requestHash` ni token. */
export type PaymentView = {
  id: string;
  orderId: string;
  monto: number;
  moneda: string;
  metodo: string;
  status: string;
  referencia?: string;
  motivoRechazo?: string;
  createdAt: Date;
};

type ViewSource = {
  _id: Types.ObjectId;
  orderId: Types.ObjectId | string;
  monto: number;
  moneda: string;
  metodo: string;
  status: string;
  referencia?: string;
  motivoRechazo?: string;
  createdAt: Date;
};

/** Lista blanca de campos: lo que no se nombra aquí no sale en ninguna respuesta. */
export function toPaymentView(payment: ViewSource): PaymentView {
  return {
    id: String(payment._id),
    orderId: String(payment.orderId),
    monto: payment.monto,
    moneda: payment.moneda,
    metodo: payment.metodo,
    status: payment.status,
    referencia: payment.referencia,
    motivoRechazo: payment.motivoRechazo,
    createdAt: payment.createdAt,
  };
}

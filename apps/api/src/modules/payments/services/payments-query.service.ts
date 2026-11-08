import { Injectable, NotFoundException } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import type { Model, QueryFilter } from 'mongoose';
import type {
  AdminPaymentsQuery,
  PaymentsQuery,
} from '../dto/payment-query.dto.js';
import { type Page, skipFor, toPage } from '../policies/pagination.policy.js';
import {
  PaymentAttempt,
  type PaymentAttemptDocument,
} from '../schemas/payment-attempt.schema.js';
import {
  Payment,
  type PaymentDocument,
  type PaymentStatus,
} from '../schemas/payment.schema.js';
import { type PaymentView, toPaymentView } from './payment-view.js';

/** Resumen del ADMIN: la vista del PRODUCTOR más el comprador. */
export type AdminPaymentView = PaymentView & { buyerId: string };

/** Un intento del historial: sin token, firma ni cuerpo (nunca se guardan). */
export type PaymentAttemptView = {
  origen: string;
  resultado: string;
  motivo?: string;
  createdAt: Date;
};

export type AdminPaymentDetailView = AdminPaymentView & {
  attempts: PaymentAttemptView[];
};

/** Consultas de pagos por rol; todas devuelven la vista pública, sin campos internos. */
@Injectable()
export class PaymentsQueryService {
  constructor(
    @InjectModel(Payment.name)
    private readonly paymentModel: Model<PaymentDocument>,
    @InjectModel(PaymentAttempt.name)
    private readonly attemptModel: Model<PaymentAttemptDocument>,
  ) {}

  /** Pagos del PRODUCTOR, del más reciente al más antiguo. */
  async listMine(
    buyerId: string,
    query: PaymentsQuery,
  ): Promise<Page<PaymentView>> {
    const filter: QueryFilter<PaymentDocument> = {
      buyerId,
      ...(query.status && { status: query.status as PaymentStatus }),
      ...(query.orderId && { orderId: query.orderId }),
    };
    const [payments, total] = await Promise.all([
      this.paymentModel
        .find(filter)
        .sort({ createdAt: -1, _id: -1 })
        .skip(skipFor(query.page, query.limit))
        .limit(query.limit)
        .lean(),
      this.paymentModel.countDocuments(filter),
    ]);
    return toPage(payments.map(toPaymentView), total, query.page, query.limit);
  }

  /** Pago propio; ajeno o inexistente: `404`. */
  async getMine(buyerId: string, id: string): Promise<PaymentView> {
    const payment = await this.paymentModel
      .findOne({ _id: id, buyerId })
      .lean();
    if (!payment) throw new NotFoundException('Pago no encontrado');
    return toPaymentView(payment);
  }

  /** Todos los pagos, solo lectura, con filtros `status`, `buyerId` y `orderId`. */
  async listAdmin(query: AdminPaymentsQuery): Promise<Page<AdminPaymentView>> {
    const filter: QueryFilter<PaymentDocument> = {
      ...(query.status && { status: query.status as PaymentStatus }),
      ...(query.buyerId && { buyerId: query.buyerId }),
      ...(query.orderId && { orderId: query.orderId }),
    };
    const [payments, total] = await Promise.all([
      this.paymentModel
        .find(filter)
        .sort({ createdAt: -1, _id: -1 })
        .skip(skipFor(query.page, query.limit))
        .limit(query.limit)
        .lean(),
      this.paymentModel.countDocuments(filter),
    ]);
    return toPage(
      payments.map((p) => ({ ...toPaymentView(p), buyerId: String(p.buyerId) })),
      total,
      query.page,
      query.limit,
    );
  }

  /** Detalle de cualquier pago con su historial de intentos; inexistente: `404`. */
  async getAdmin(id: string): Promise<AdminPaymentDetailView> {
    const payment = await this.paymentModel.findById(id).lean();
    if (!payment) throw new NotFoundException('Pago no encontrado');
    const attempts = await this.attemptModel
      .find({ paymentId: payment._id })
      .sort({ createdAt: 1, _id: 1 })
      .lean();
    return {
      ...toPaymentView(payment),
      buyerId: String(payment.buyerId),
      attempts: attempts.map((a) => ({
        origen: a.origen,
        resultado: a.resultado,
        motivo: a.motivo,
        createdAt: a.createdAt,
      })),
    };
  }
}

import { Injectable, Logger } from '@nestjs/common';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { InjectModel } from '@nestjs/mongoose';
import { Interval } from '@nestjs/schedule';
import type { Model, Types } from 'mongoose';
import type { DomainEvent } from '../../order/index.js';
import {
  PaymentEvents,
  type PaymentApprovedPayload,
  type PaymentDeclinedPayload,
} from '../events/payments.events.js';
import {
  Payment,
  type PaymentDocument,
  PaymentStatus,
} from '../schemas/payment.schema.js';

export const REEMIT_INTERVAL_MS = 10_000;
/** Un pago final se reemite solo si lleva al menos este tiempo sin marca. */
export const REEMIT_MIN_AGE_MS = 10_000;
/** Tras este número de reemisiones deja de reintentar (queda visible en el documento). */
export const MAX_EVENT_ATTEMPTS = 5;
/** Tope de pagos por ciclo, para que un ciclo no se alargue sin límite. */
const MAX_PER_CYCLE = 100;

/** Motivo del `payment.declined` cuando el webhook no trae ninguno. */
export const UNKNOWN_DECLINE_REASON = 'UNKNOWN';

/** Campos del `Payment` que hacen falta para emitir (sirve un documento `lean`). */
export type EmittablePayment = {
  _id: Types.ObjectId;
  orderId: Types.ObjectId;
  monto: number;
  status: string;
  motivoRechazo?: string;
  eventId?: string;
  finalizedAt?: Date;
};

type PaymentEnvelope = DomainEvent<
  string,
  PaymentApprovedPayload | PaymentDeclinedPayload
>;

/**
 * Emite en memoria `payment.approved` y `payment.declined` tras el commit del
 * cambio de estado. No usa el outbox (es de `order`); entrega al menos una vez
 * y `order` es idempotente por `eventId`.
 */
@Injectable()
export class PaymentEventsService {
  private readonly logger = new Logger(PaymentEventsService.name);
  /** Un ciclo no se solapa con el anterior (una sola instancia). */
  private running = false;

  constructor(
    @InjectModel(Payment.name)
    private readonly paymentModel: Model<PaymentDocument>,
    private readonly events: EventEmitter2,
  ) {}

  /**
   * Emite el evento del estado final y marca `eventEmittedAt`. Devuelve `true`
   * si quedó marcado. Nunca lanza: si falla, el pago queda sin marca y el job de
   * reemisión lo reintenta con el mismo `eventId`.
   */
  async emit(payment: EmittablePayment): Promise<boolean> {
    const envelope = this.buildEnvelope(payment);
    if (!envelope) return false;

    try {
      await this.events.emitAsync(envelope.type, envelope);
      await this.paymentModel.updateOne(
        { _id: payment._id },
        { $set: { eventEmittedAt: new Date() } },
      );
      return true;
    } catch (error) {
      // Sin payload: solo el pago y el motivo técnico.
      this.logger.error(
        `No se pudo emitir ${envelope.type} del pago ${String(payment._id)}: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
      return false;
    }
  }

  /**
   * Reemite con el mismo `eventId` los pagos finales cuyo evento no quedó
   * marcado (caída entre el commit y la emisión, o un consumidor que falló).
   * Cada reemisión suma `eventAttempts`; al llegar a 5 deja de reintentar.
   */
  @Interval(REEMIT_INTERVAL_MS)
  async reemit(): Promise<void> {
    if (this.running) return;
    this.running = true;
    try {
      const cutoff = new Date(Date.now() - REEMIT_MIN_AGE_MS);
      const pending = await this.paymentModel
        .find({
          status: {
            $in: [
              PaymentStatus.APPROVED,
              PaymentStatus.DECLINED,
              PaymentStatus.ERROR,
            ],
          },
          eventEmittedAt: { $exists: false },
          finalizedAt: { $lt: cutoff },
          eventAttempts: { $lt: MAX_EVENT_ATTEMPTS },
        })
        .sort({ finalizedAt: 1 })
        .limit(MAX_PER_CYCLE)
        .lean<EmittablePayment[]>();

      for (const payment of pending) {
        // Reclamo atómico: suma el intento solo si sigue sin marca y bajo el tope.
        const claimed = await this.paymentModel
          .findOneAndUpdate(
            {
              _id: payment._id,
              eventEmittedAt: { $exists: false },
              eventAttempts: { $lt: MAX_EVENT_ATTEMPTS },
            },
            { $inc: { eventAttempts: 1 } },
            { returnDocument: 'after' },
          )
          .lean<EmittablePayment>();
        if (claimed) await this.emit(claimed);
      }
    } catch (error) {
      this.logger.error(
        `Ciclo de reemisión de pagos falló: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    } finally {
      this.running = false;
    }
  }

  /** `null` si el pago no está en un estado final con `eventId`. */
  private buildEnvelope(payment: EmittablePayment): PaymentEnvelope | null {
    if (!payment.eventId) return null;
    const orderId = String(payment.orderId);
    const paymentId = String(payment._id);

    let type: string;
    let payload: PaymentApprovedPayload | PaymentDeclinedPayload;
    if (payment.status === 'APPROVED') {
      type = PaymentEvents.PaymentApproved;
      payload = { orderId, paymentId, monto: payment.monto };
    } else if (payment.status === 'DECLINED' || payment.status === 'ERROR') {
      type = PaymentEvents.PaymentDeclined;
      payload = {
        orderId,
        paymentId,
        motivo: payment.motivoRechazo ?? UNKNOWN_DECLINE_REASON,
      };
    } else {
      return null;
    }

    return {
      eventId: payment.eventId,
      type,
      occurredAt: (payment.finalizedAt ?? new Date()).toISOString(),
      correlationId: orderId,
      payload,
    };
  }
}

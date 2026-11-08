import { randomUUID } from 'node:crypto';
import {
  ConflictException,
  Inject,
  Injectable,
  Logger,
  NotFoundException,
  UnprocessableEntityException,
} from '@nestjs/common';
import { InjectConnection, InjectModel } from '@nestjs/mongoose';
import type { Connection, Model, Types } from 'mongoose';
import { OrderQueryService } from '../../order/index.js';
import type { CreatePaymentDto } from '../dto/create-payment.dto.js';
import { isDuplicateKeyError } from '../policies/duplicate-key.policy.js';
import { computeRequestHash } from '../policies/request-hash.policy.js';
import {
  type AttemptOrigen,
  type AttemptResultado,
  PaymentAttempt,
  type PaymentAttemptDocument,
} from '../schemas/payment-attempt.schema.js';
import {
  Payment,
  type PaymentDocument,
  type PaymentMetodo,
  PaymentStatus,
} from '../schemas/payment.schema.js';
import { PaymentEventsService } from './payment-events.service.js';
import {
  PAYMENT_GATEWAY,
  type GatewayChargeResult,
  type PaymentGateway,
} from './payment-gateway.js';

/** Un `Payment` ya leído de Mongo (objeto plano, documento `lean`). */
export type PaymentRecord = { [K in keyof Payment]: Payment[K] } & {
  _id: Types.ObjectId;
};

export type CreatePaymentResult = {
  payment: PaymentRecord;
  /** `true` si es un reintento con la misma `Idempotency-Key` (responde `200`). */
  replay: boolean;
};

/** Lo que `PaymentsService` necesita del resultado de la pasarela. */
type Outcome = Pick<GatewayChargeResult, 'resultado' | 'motivo'> &
  Partial<Pick<GatewayChargeResult, 'referencia'>>;

/** Resultado cuando la pasarela lanza una excepción inesperada. */
const GATEWAY_FAILURE: Outcome = {
  resultado: 'ERROR',
  motivo: 'GATEWAY_ERROR',
};

@Injectable()
export class PaymentsService {
  private readonly logger = new Logger(PaymentsService.name);

  constructor(
    @InjectConnection() private readonly connection: Connection,
    @InjectModel(Payment.name)
    private readonly paymentModel: Model<PaymentDocument>,
    @InjectModel(PaymentAttempt.name)
    private readonly attemptModel: Model<PaymentAttemptDocument>,
    private readonly orderQuery: OrderQueryService,
    @Inject(PAYMENT_GATEWAY) private readonly gateway: PaymentGateway,
    private readonly events: PaymentEventsService,
  ) {}

  /**
   * Alta idempotente y cobro. Un reintento con la misma `Idempotency-Key`
   * devuelve el pago existente sin cobrar de nuevo.
   */
  async create(
    buyerId: string,
    idempotencyKey: string,
    dto: CreatePaymentDto,
  ): Promise<CreatePaymentResult> {
    const started = await this.start(buyerId, idempotencyKey, dto);
    if (started.replay) return started;
    return {
      payment: await this.charge(started.payment, dto.token),
      replay: false,
    };
  }

  /**
   * Reutiliza el pago de `(buyerId, idempotencyKey)` o valida el pedido e
   * inserta un `Payment` en `PENDING` con el monto de `order`.
   */
  private async start(
    buyerId: string,
    idempotencyKey: string,
    dto: CreatePaymentDto,
  ): Promise<CreatePaymentResult> {
    const requestHash = computeRequestHash(dto);

    // Antes de mirar el pedido, que puede haber cambiado desde el primer intento.
    const existing = await this.findByKey(buyerId, idempotencyKey);
    if (existing) return this.replay(existing, requestHash);

    const order = await this.orderQuery.getOrderForPayment(
      dto.orderId,
      buyerId,
    );
    if (!order) throw new NotFoundException('Pedido no encontrado');
    if (
      order.status !== 'AWAITING_PAYMENT' ||
      (order.expiresAt !== null && order.expiresAt.getTime() <= Date.now())
    ) {
      throw new ConflictException({
        code: 'ORDER_NOT_PAYABLE',
        message: 'El pedido no admite pago',
      });
    }

    try {
      const created = await this.paymentModel.create({
        orderId: dto.orderId,
        buyerId,
        monto: order.total,
        moneda: order.moneda,
        metodo: dto.metodo as PaymentMetodo,
        idempotencyKey,
        requestHash,
      });
      return { payment: created.toObject() as PaymentRecord, replay: false };
    } catch (error) {
      if (!isDuplicateKeyError(error)) throw error;
      // Doble clic simultáneo: el otro pedido ya insertó esta clave.
      const winner = await this.findByKey(buyerId, idempotencyKey);
      if (winner) return this.replay(winner, requestHash);
      // Si no, el conflicto es el del índice parcial sobre `orderId`.
      throw new ConflictException({
        code: 'PAYMENT_IN_PROGRESS',
        message: 'El pedido ya tiene un pago en curso o aprobado',
      });
    }
  }

  /** `PENDING` → `PROCESSING`, cobro en la pasarela, cierre y emisión del evento. */
  private async charge(
    payment: PaymentRecord,
    token: string,
  ): Promise<PaymentRecord> {
    const processing = await this.paymentModel
      .findOneAndUpdate(
        { _id: payment._id, status: PaymentStatus.PENDING },
        { $set: { status: PaymentStatus.PROCESSING } },
        { returnDocument: 'after' },
      )
      .lean<PaymentRecord>()
      .exec();
    if (!processing) return this.reload(payment);

    let outcome: Outcome;
    try {
      outcome = await this.gateway.charge({
        monto: processing.monto,
        moneda: processing.moneda,
        metodo: processing.metodo,
        token,
      });
    } catch (error) {
      // Sin el token ni el cuerpo: solo el pago y el motivo técnico.
      this.logger.error(
        `La pasarela falló para el pago ${String(processing._id)}: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
      outcome = GATEWAY_FAILURE;
    }

    const settled = await this.settle(processing, outcome);
    if (settled.final) await this.events.emit(settled.payment);
    return settled.payment;
  }

  /**
   * En una sola transacción: estado final del `Payment` (condicional a
   * `PROCESSING`) y su `PaymentAttempt`. Con `PROCESSING` no hay estado final:
   * solo se registra el intento.
   */
  private async settle(
    payment: PaymentRecord,
    outcome: Outcome,
  ): Promise<{ payment: PaymentRecord; final: boolean }> {
    const changes =
      outcome.resultado === 'PROCESSING'
        ? null
        : {
            status: outcome.resultado as PaymentStatus,
            eventId: randomUUID(),
            finalizedAt: new Date(),
            ...(outcome.referencia ? { referencia: outcome.referencia } : {}),
            ...(outcome.motivo ? { motivoRechazo: outcome.motivo } : {}),
          };

    let applied = true;
    const session = await this.connection.startSession();
    try {
      await session.withTransaction(async () => {
        applied = true;
        if (changes) {
          const result = await this.paymentModel.updateOne(
            { _id: payment._id, status: PaymentStatus.PROCESSING },
            { $set: changes },
            { session },
          );
          if (result.modifiedCount === 0) {
            // Otro camino (el webhook) lo resolvió mientras tanto.
            applied = false;
            return;
          }
        }
        await this.attemptModel.create(
          [
            {
              paymentId: payment._id,
              orderId: payment.orderId,
              buyerId: payment.buyerId,
              origen: 'SIMULATOR' as AttemptOrigen,
              resultado: outcome.resultado as AttemptResultado,
              ...(outcome.motivo ? { motivo: outcome.motivo } : {}),
            },
          ],
          { session },
        );
      });
    } finally {
      await session.endSession();
    }

    if (!applied) return { payment: await this.reload(payment), final: false };
    return {
      payment: changes ? { ...payment, ...changes } : payment,
      final: changes !== null,
    };
  }

  private async reload(payment: PaymentRecord): Promise<PaymentRecord> {
    const current = await this.paymentModel
      .findById(payment._id)
      .lean<PaymentRecord>()
      .exec();
    return current ?? payment;
  }

  private findByKey(
    buyerId: string,
    idempotencyKey: string,
  ): Promise<PaymentRecord | null> {
    return this.paymentModel
      .findOne({ buyerId, idempotencyKey })
      .lean<PaymentRecord>()
      .exec();
  }

  /** Misma clave y mismo cuerpo: el mismo pago. Cuerpo distinto: `422`. */
  private replay(
    existing: PaymentRecord,
    requestHash: string,
  ): CreatePaymentResult {
    if (existing.requestHash !== requestHash) {
      throw new UnprocessableEntityException(
        'La Idempotency-Key ya se usó con otro cuerpo',
      );
    }
    return { payment: existing, replay: true };
  }
}

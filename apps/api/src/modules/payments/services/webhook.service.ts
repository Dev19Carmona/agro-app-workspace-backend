import { randomUUID } from 'node:crypto';
import {
  Injectable,
  NotFoundException,
  UnauthorizedException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InjectConnection, InjectModel } from '@nestjs/mongoose';
import type { Connection, Model } from 'mongoose';
import type { ApiEnv } from '../../../../../../libs/common/src/config/env.schema.js';
import type { WebhookDto } from '../dto/webhook.dto.js';
import { isDuplicateKeyError } from '../policies/duplicate-key.policy.js';
import { verifyWebhookSignature } from '../policies/webhook-signature.policy.js';
import {
  AttemptOrigen,
  type AttemptResultado,
  PaymentAttempt,
  type PaymentAttemptDocument,
} from '../schemas/payment-attempt.schema.js';
import {
  Payment,
  type PaymentDocument,
  PaymentStatus,
} from '../schemas/payment.schema.js';
import {
  PaymentProcessedEvent,
  type PaymentProcessedEventDocument,
} from '../schemas/processed-event.schema.js';
import { PaymentEventsService } from './payment-events.service.js';
import type { PaymentRecord } from './payments.service.js';

/** Mismo mensaje para toda causa de rechazo: no indica qué comprobación falló. */
const INVALID_SIGNATURE = 'Firma inválida';

@Injectable()
export class WebhookService {
  constructor(
    private readonly config: ConfigService<ApiEnv, true>,
    @InjectConnection() private readonly connection: Connection,
    @InjectModel(Payment.name)
    private readonly paymentModel: Model<PaymentDocument>,
    @InjectModel(PaymentAttempt.name)
    private readonly attemptModel: Model<PaymentAttemptDocument>,
    @InjectModel(PaymentProcessedEvent.name)
    private readonly processedModel: Model<PaymentProcessedEventDocument>,
    private readonly events: PaymentEventsService,
  ) {}

  /** `401` genérico si faltan headers, el timestamp está fuera de rango o la firma no coincide. */
  verifySignature(
    rawBody: Buffer | undefined,
    timestamp: string | undefined,
    signature: string | undefined,
  ): void {
    const valid = verifyWebhookSignature({
      secret: this.config.get('PAYMENTS_WEBHOOK_SECRET', { infer: true }),
      timestamp,
      rawBody: rawBody ?? Buffer.alloc(0),
      signature,
      now: Math.floor(Date.now() / 1000),
    });
    if (!valid) throw new UnauthorizedException(INVALID_SIGNATURE);
  }

  /**
   * Protección contra repetición + resolución de un pago `PROCESSING`, todo en
   * una transacción. Un `eventId` repetido o un pago ya resuelto no cambian nada.
   * No consulta el pedido: `order` decide qué hacer con un pago tardío.
   */
  async resolve(dto: WebhookDto): Promise<void> {
    let resolved = null as PaymentRecord | null;
    const session = await this.connection.startSession();
    try {
      await session.withTransaction(async () => {
        resolved = null;
        await this.processedModel.create([{ eventId: dto.eventId }], {
          session,
        });

        const payment = await this.paymentModel
          .findById(dto.paymentId)
          .session(session)
          .select('_id')
          .lean();
        // Lanzar aquí aborta la transacción y deja libre el `eventId`.
        if (!payment) throw new NotFoundException('Pago no encontrado');

        const status = dto.resultado as PaymentStatus;
        const updated = await this.paymentModel
          .findOneAndUpdate(
            { _id: payment._id, status: PaymentStatus.PROCESSING },
            {
              $set: {
                status,
                eventId: randomUUID(),
                finalizedAt: new Date(),
                ...(status !== PaymentStatus.APPROVED && dto.motivo
                  ? { motivoRechazo: dto.motivo }
                  : {}),
              },
            },
            { session, returnDocument: 'after' },
          )
          .lean<PaymentRecord>();
        // Ya resuelto: no se toca nada y el `eventId` queda marcado.
        if (!updated) return;

        await this.attemptModel.create(
          [
            {
              paymentId: updated._id,
              orderId: updated.orderId,
              buyerId: updated.buyerId,
              origen: AttemptOrigen.WEBHOOK,
              resultado: dto.resultado as AttemptResultado,
              ...(dto.motivo ? { motivo: dto.motivo } : {}),
            },
          ],
          { session },
        );
        resolved = updated;
      });
    } catch (error) {
      // Mismo `eventId` ya procesado: respuesta `200` sin cambios.
      if (isDuplicateKeyError(error)) return;
      throw error;
    } finally {
      await session.endSession();
    }

    if (resolved) await this.events.emit(resolved);
  }
}

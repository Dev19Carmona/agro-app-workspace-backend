import { Injectable, Logger } from '@nestjs/common';
import { InjectConnection, InjectModel } from '@nestjs/mongoose';
import { Interval } from '@nestjs/schedule';
import type { ClientSession, Connection, Model, Types } from 'mongoose';
import { OrderEvents } from '../events/order.events.js';
import {
  CancelReason,
  Order,
  type OrderDocument,
  OrderStatus,
} from '../schemas/order.schema.js';
import { OutboxService } from './outbox.service.js';

export const EXPIRATION_INTERVAL_MS = 10_000;
/** `catalog` tiene este tiempo para responder `stock.reserved` o `stock.rejected`. */
export const STOCK_RESPONSE_TIMEOUT_MS = 5 * 60 * 1000;
const MAX_CANDIDATES = 100;

type Candidate = { _id: Types.ObjectId; buyerId: Types.ObjectId };

/**
 * Cancela los pedidos vencidos: `AWAITING_PAYMENT` con `expiresAt` pasado
 * (`EXPIRED`) y `PENDING` sin respuesta de `catalog` en 5 min (`STOCK_TIMEOUT`).
 * Cada pedido va en su propia transacción y con actualización condicional: si
 * un `payment.approved` o un `stock.*` cambió el estado antes, no se cancela.
 */
@Injectable()
export class OrderExpirationService {
  private readonly logger = new Logger(OrderExpirationService.name);
  /** Un ciclo no se solapa con el anterior (una sola instancia). */
  private running = false;

  constructor(
    @InjectConnection() private readonly connection: Connection,
    @InjectModel(Order.name) private readonly orderModel: Model<OrderDocument>,
    private readonly outbox: OutboxService,
  ) {}

  @Interval(EXPIRATION_INTERVAL_MS)
  async expireOrders(): Promise<void> {
    if (this.running) return;
    this.running = true;
    try {
      const now = Date.now();
      const awaiting = await this.orderModel
        .find({
          status: OrderStatus.AWAITING_PAYMENT,
          expiresAt: { $lte: new Date(now) },
        })
        .select('buyerId')
        .limit(MAX_CANDIDATES)
        .lean();
      for (const order of awaiting) {
        await this.cancel(
          order,
          {
            status: OrderStatus.AWAITING_PAYMENT,
            expiresAt: { $lte: new Date(now) },
          },
          CancelReason.EXPIRED,
        );
      }

      const stale = new Date(now - STOCK_RESPONSE_TIMEOUT_MS);
      const pending = await this.orderModel
        .find({ status: OrderStatus.PENDING, createdAt: { $lte: stale } })
        .select('buyerId')
        .limit(MAX_CANDIDATES)
        .lean();
      for (const order of pending) {
        await this.cancel(
          order,
          { status: OrderStatus.PENDING, createdAt: { $lte: stale } },
          CancelReason.STOCK_TIMEOUT,
        );
      }
    } catch (error) {
      this.logger.error(`Ciclo de expiración falló: ${errorMessage(error)}`);
    } finally {
      this.running = false;
    }
  }

  /** Cancela un pedido; un fallo no frena a los demás candidatos. */
  private async cancel(
    order: Candidate,
    condition: Record<string, unknown>,
    reason: CancelReason.EXPIRED | CancelReason.STOCK_TIMEOUT,
  ): Promise<void> {
    const session = await this.connection.startSession();
    try {
      await session.withTransaction(async () => {
        const { modifiedCount } = await this.orderModel.updateOne(
          { _id: order._id, ...condition },
          { $set: { status: OrderStatus.CANCELLED, cancelReason: reason } },
          { session },
        );
        if (modifiedCount === 0) {
          // Otro evento ganó la carrera: no se cancela ni se emite nada.
          await abort(session);
          return;
        }
        await this.outbox.add(
          session,
          OrderEvents.OrderCancelled,
          String(order._id),
          {
            orderId: String(order._id),
            buyerId: String(order.buyerId),
            motivo: reason,
          },
        );
      });
    } catch (error) {
      this.logger.error(
        `No se pudo expirar el pedido ${String(order._id)}: ${errorMessage(error)}`,
      );
    } finally {
      await session.endSession();
    }
  }
}

const abort = (session: ClientSession) => session.abortTransaction();

const errorMessage = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);

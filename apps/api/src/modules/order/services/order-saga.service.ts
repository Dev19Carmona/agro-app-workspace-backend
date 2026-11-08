import { Injectable, Logger } from '@nestjs/common';
import { OnEvent } from '@nestjs/event-emitter';
import { InjectConnection, InjectModel } from '@nestjs/mongoose';
import type { ClientSession, Connection, Model, Types } from 'mongoose';
import {
  CatalogEvents,
  type DomainEvent,
  type StockRejectedPayload,
  type StockReleasedPayload,
  type StockReservedPayload,
} from '../../catalog/index.js';
import {
  ConsumedEvents,
  OrderEvents,
  type PaymentApprovedPayload,
  type PaymentDeclinedPayload,
} from '../events/order.events.js';
import { isDuplicateKeyError } from '../policies/duplicate-key.policy.js';
import { canTransition } from '../policies/order-state.policy.js';
import {
  CancelReason,
  Order,
  type OrderDocument,
  OrderStatus,
} from '../schemas/order.schema.js';
import {
  OrderProcessedEvent,
  type OrderProcessedEventDocument,
} from '../schemas/processed-event.schema.js';
import { OutboxService } from './outbox.service.js';

/** Tiempo que tiene el comprador para pagar desde `stock.reserved`. */
export const PAYMENT_WINDOW_MS = 15 * 60 * 1000;

const OBJECT_ID = /^[a-f\d]{24}$/i;

type OrderSnapshot = {
  _id: Types.ObjectId;
  buyerId: Types.ObjectId;
  total: number;
  status: OrderStatus;
};

/**
 * Saga del pedido: reacciona a los eventos de `catalog` (y, más adelante, de
 * `payments`). Cada transición ocurre en una transacción con la actualización
 * condicional del pedido, el outbox y el `eventId` consumido.
 */
@Injectable()
export class OrderSagaService {
  private readonly logger = new Logger(OrderSagaService.name);

  constructor(
    @InjectConnection() private readonly connection: Connection,
    @InjectModel(Order.name) private readonly orderModel: Model<OrderDocument>,
    @InjectModel(OrderProcessedEvent.name)
    private readonly processedModel: Model<OrderProcessedEventDocument>,
    private readonly outbox: OutboxService,
  ) {}

  /**
   * `PENDING` → `AWAITING_PAYMENT` con `expiresAt` a 15 min. Si el pedido ya
   * está `CANCELLED` (expiró el `PENDING`), `catalog` quedó con stock reservado:
   * se emite `order.cancelled` con `LATE_RESERVATION` para que lo libere.
   */
  @OnEvent(CatalogEvents.StockReserved)
  async handleStockReserved(
    event: DomainEvent<'stock.reserved', StockReservedPayload>,
  ): Promise<void> {
    await this.consume(event, async (session, order) => {
      if (canTransition(order.status, OrderStatus.AWAITING_PAYMENT)) {
        await this.orderModel.updateOne(
          { _id: order._id, status: OrderStatus.PENDING },
          {
            $set: {
              status: OrderStatus.AWAITING_PAYMENT,
              expiresAt: new Date(Date.now() + PAYMENT_WINDOW_MS),
            },
          },
          { session },
        );
      } else if (order.status === OrderStatus.CANCELLED) {
        await this.outbox.add(
          session,
          OrderEvents.OrderCancelled,
          String(order._id),
          {
            orderId: String(order._id),
            buyerId: String(order.buyerId),
            motivo: 'LATE_RESERVATION',
          },
        );
      }
    });
  }

  /** `PENDING` → `CANCELLED` y `order.cancelled`. En otro estado solo marca procesado. */
  @OnEvent(CatalogEvents.StockRejected)
  async handleStockRejected(
    event: DomainEvent<'stock.rejected', StockRejectedPayload>,
  ): Promise<void> {
    await this.consume(event, async (session, order) => {
      // Solo `PENDING` se cancela por rechazo de stock (la otra salida a CANCELLED es la expiración).
      if (order.status !== OrderStatus.PENDING) return;
      const { modifiedCount } = await this.orderModel.updateOne(
        { _id: order._id, status: OrderStatus.PENDING },
        {
          $set: {
            status: OrderStatus.CANCELLED,
            cancelReason: CancelReason.STOCK_REJECTED,
          },
        },
        { session },
      );
      if (modifiedCount === 0) return;
      await this.outbox.add(
        session,
        OrderEvents.OrderCancelled,
        String(order._id),
        {
          orderId: String(order._id),
          buyerId: String(order.buyerId),
          motivo: 'STOCK_REJECTED',
        },
      );
    });
  }

  /**
   * `AWAITING_PAYMENT` → `CONFIRMED` y `order.confirmed`. No mira `expiresAt`:
   * un pago tardío confirma mientras el estado siga siendo `AWAITING_PAYMENT`.
   * En cualquier otro estado se ignora (el pedido no se reabre; no hay
   * reembolsos), se marca procesado y se deja un `warn`.
   */
  @OnEvent(ConsumedEvents.PaymentApproved)
  async handlePaymentApproved(
    event: DomainEvent<'payment.approved', PaymentApprovedPayload>,
  ): Promise<void> {
    await this.consume(event, async (session, order) => {
      const confirmed =
        order.status === OrderStatus.AWAITING_PAYMENT &&
        (
          await this.orderModel.updateOne(
            { _id: order._id, status: OrderStatus.AWAITING_PAYMENT },
            { $set: { status: OrderStatus.CONFIRMED } },
            { session },
          )
        ).modifiedCount > 0;
      if (!confirmed) {
        this.logger.warn(
          `payment.approved ignorado: el pedido ${String(order._id)} está ${order.status}`,
        );
        return;
      }
      await this.outbox.add(
        session,
        OrderEvents.OrderConfirmed,
        String(order._id),
        {
          orderId: String(order._id),
          buyerId: String(order.buyerId),
          total: order.total,
        },
      );
    });
  }

  /** No cambia el estado: el pedido sigue en `AWAITING_PAYMENT` mientras no venza. */
  @OnEvent(ConsumedEvents.PaymentDeclined)
  async handlePaymentDeclined(
    event: DomainEvent<'payment.declined', PaymentDeclinedPayload>,
  ): Promise<void> {
    await this.consume(event, (_session, order) => {
      this.logger.log(
        `Pago rechazado (${event.payload.motivo}) del pedido ${String(order._id)}; sigue ${order.status}`,
      );
      return Promise.resolve();
    });
  }

  /** `catalog` ya liberó el stock; `order` solo lo registra y marca procesado. */
  @OnEvent(CatalogEvents.StockReleased)
  async handleStockReleased(
    event: DomainEvent<'stock.released', StockReleasedPayload>,
  ): Promise<void> {
    await this.consume(event, (_session, order) => {
      this.logger.log(`Stock liberado del pedido ${String(order._id)}`);
      return Promise.resolve();
    });
  }

  /**
   * Idempotencia + transacción. Si el `eventId` ya está en
   * `order_processed_events` no hace nada; si no, ejecuta `apply` y lo marca
   * procesado en la misma transacción. Un pedido inexistente solo se marca.
   */
  private async consume(
    event: DomainEvent<string, { orderId: string }>,
    apply: (session: ClientSession, order: OrderSnapshot) => Promise<void>,
  ): Promise<void> {
    if (await this.processedModel.exists({ eventId: event.eventId })) return;

    const orderId = event.payload.orderId;
    const session = await this.connection.startSession();
    try {
      await session.withTransaction(async () => {
        const order = OBJECT_ID.test(orderId)
          ? await this.orderModel
              .findById(orderId)
              .select('buyerId status total')
              .session(session)
              .lean()
          : null;
        if (order) await apply(session, order);
        else {
          this.logger.warn(
            `Evento ${event.type} para un pedido inexistente (${orderId})`,
          );
        }
        await this.processedModel.create(
          [{ eventId: event.eventId, type: event.type }],
          { session },
        );
      });
    } catch (error) {
      // Mismo eventId procesado en paralelo: la otra entrega ya hizo el trabajo.
      if (isDuplicateKeyError(error)) return;
      throw error;
    } finally {
      await session.endSession();
    }
  }
}

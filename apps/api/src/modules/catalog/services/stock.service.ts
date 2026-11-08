import {
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { InjectConnection, InjectModel } from '@nestjs/mongoose';
import { randomUUID } from 'node:crypto';
import { type ClientSession, type Connection, type Model } from 'mongoose';
import {
  CatalogEvents,
  type DomainEvent,
  type OrderCancelledPayload,
  type OrderConfirmedPayload,
  type OrderCreatedPayload,
  type StockItem,
  type StockRejectedPayload,
  type StockReleasedPayload,
  type StockReservedPayload,
} from '../events/catalog.events.js';
import { isDuplicateKeyError } from '../policies/duplicate-key.policy.js';
import {
  ProcessedEvent,
  type ProcessedEventDocument,
} from '../schemas/processed-event.schema.js';
import {
  ProductVariant,
  type ProductVariantDocument,
} from '../schemas/product-variant.schema.js';
import { Product, type ProductDocument } from '../schemas/product.schema.js';
import {
  ReservationStatus,
  StockReservation,
  type StockReservationDocument,
} from '../schemas/stock-reservation.schema.js';
import { Store, type StoreDocument } from '../schemas/store.schema.js';
import { CatalogQueryService } from './catalog-query.service.js';
import { type VariantView, toVariantView } from './products.service.js';

type RejectedItem = StockRejectedPayload['items'][number];
type OrderCreatedEvent = DomainEvent<'order.created', OrderCreatedPayload>;

/** Aborta la transacción de reserva cuando algún ítem no alcanza. */
class InsufficientStockError extends Error {}

/** Suma las cantidades de ítems repetidos de una misma variante. */
const mergeItems = (items: StockItem[]): StockItem[] => {
  const merged = new Map<string, number>();
  for (const { variantId, cantidad } of items) {
    merged.set(variantId, (merged.get(variantId) ?? 0) + cantidad);
  }
  return [...merged].map(([variantId, cantidad]) => ({ variantId, cantidad }));
};

@Injectable()
export class StockService {
  constructor(
    @InjectModel(Store.name) private readonly storeModel: Model<StoreDocument>,
    @InjectModel(Product.name)
    private readonly productModel: Model<ProductDocument>,
    @InjectModel(ProductVariant.name)
    private readonly variantModel: Model<ProductVariantDocument>,
    @InjectModel(StockReservation.name)
    private readonly reservationModel: Model<StockReservationDocument>,
    @InjectModel(ProcessedEvent.name)
    private readonly processedModel: Model<ProcessedEventDocument>,
    @InjectConnection() private readonly connection: Connection,
    private readonly events: EventEmitter2,
    private readonly catalogQuery: CatalogQueryService,
  ) {}

  /**
   * Fija el stock con un valor absoluto en una variante propia (una ajena
   * responde 404). Si `stock < stockReservado` responde 409 y no cambia nada:
   * la comparación va en la propia actualización condicional, no en una
   * lectura previa, para no pisar una reserva concurrente.
   */
  async setStock(
    ownerId: string,
    variantId: string,
    stock: number,
  ): Promise<VariantView> {
    const store = await this.storeModel.findOne({ ownerId }).lean();
    if (!store) throw new ForbiddenException('Aún no tienes una tienda');

    const variant = await this.variantModel.findById(variantId).lean();
    const owns =
      variant &&
      (await this.productModel.exists({
        _id: variant.productId,
        storeId: store._id,
      }));
    if (!owns) throw new NotFoundException('Variante no encontrada');

    const updated = await this.variantModel
      .findOneAndUpdate(
        { _id: variantId, $expr: { $lte: ['$stockReservado', stock] } },
        { $set: { stock } },
        { new: true },
      )
      .lean();
    if (!updated) {
      throw new ConflictException(
        'El stock no puede ser menor que el stock reservado',
      );
    }
    return toVariantView(updated);
  }

  /**
   * Reserva el stock de un `order.created`. Todo o nada: la transacción se
   * aborta si algún ítem no alcanza, así no queda ninguna reserva parcial.
   * Los `stock.*` se emiten en memoria después del commit. Idempotente por
   * `eventId` (`processed_events`) y por `orderId` (`stock_reservations`).
   */
  async reserve(event: OrderCreatedEvent): Promise<void> {
    const { eventId, payload } = event;
    if (await this.processedModel.exists({ eventId })) return;

    const items = mergeItems(payload.items);
    const unavailable = await this.findUnavailable(items);
    if (unavailable.length > 0) {
      await this.saveRejected(event, items, 'VARIANT_UNAVAILABLE', unavailable);
      return;
    }

    let failed: StockItem[] = [];
    try {
      await this.inTransaction(async (session) => {
        failed = [];
        for (const { variantId, cantidad } of items) {
          const res = await this.variantModel.updateOne(
            {
              _id: variantId,
              activo: true,
              $expr: {
                $gte: [{ $subtract: ['$stock', '$stockReservado'] }, cantidad],
              },
            },
            { $inc: { stockReservado: cantidad } },
            { session },
          );
          if (res.modifiedCount === 0) failed.push({ variantId, cantidad });
        }
        if (failed.length > 0) throw new InsufficientStockError();
        await this.reservationModel.create(
          [
            {
              orderId: payload.orderId,
              status: ReservationStatus.RESERVED,
              items,
            },
          ],
          { session },
        );
        await this.processedModel.create([{ eventId, type: event.type }], {
          session,
        });
      });
    } catch (error) {
      if (error instanceof InsufficientStockError) {
        await this.saveRejected(
          event,
          items,
          'INSUFFICIENT_STOCK',
          await this.withDisponible(failed),
        );
        return;
      }
      // Mismo eventId u orderId procesado en paralelo: la transacción se
      // abortó entera, no queda stock reservado de más.
      if (isDuplicateKeyError(error)) return;
      throw error;
    }

    this.emitStock(CatalogEvents.StockReserved, payload.orderId, {
      orderId: payload.orderId,
      items,
    } satisfies StockReservedPayload);
  }

  /**
   * `order.confirmed`: si la reserva está `RESERVED`, descuenta `stock` y
   * `stockReservado` por ítem y la pasa a `CONFIRMED`, todo en una
   * transacción. En cualquier otro estado (o sin reserva) no hace nada.
   */
  async confirm(
    event: DomainEvent<'order.confirmed', OrderConfirmedPayload>,
  ): Promise<void> {
    await this.transition(
      event.payload.orderId,
      ReservationStatus.CONFIRMED,
      -1,
    );
  }

  /**
   * `order.cancelled`: si la reserva está `RESERVED`, libera `stockReservado`
   * por ítem, la pasa a `RELEASED` y emite `stock.released`. Si está
   * `REJECTED`, `CONFIRMED`, `RELEASED` o no existe, no libera ni emite: un
   * pedido cancelado por `stock.rejected` nunca libera stock.
   */
  async release(
    event: DomainEvent<'order.cancelled', OrderCancelledPayload>,
  ): Promise<void> {
    const { orderId } = event.payload;
    const items = await this.transition(orderId, ReservationStatus.RELEASED, 0);
    if (!items) return;
    this.emitStock(CatalogEvents.StockReleased, orderId, {
      orderId,
      items,
    } satisfies StockReleasedPayload);
  }

  /**
   * Pasa una reserva `RESERVED` a `to` y ajusta las variantes en la misma
   * transacción. `stockDelta` se suma a `stock` (−1 = descuenta la cantidad,
   * 0 = no toca `stock`); `stockReservado` siempre baja. Devuelve los ítems si
   * hizo la transición, o `null` si la reserva no estaba `RESERVED`. La
   * transición condicional es lo que vuelve idempotente el proceso: una
   * segunda llamada, o una concurrente, ya no la encuentra `RESERVED`.
   */
  private async transition(
    orderId: string,
    to: ReservationStatus.CONFIRMED | ReservationStatus.RELEASED,
    stockDelta: -1 | 0,
  ): Promise<StockItem[] | null> {
    let items: StockItem[] | null = null;
    await this.inTransaction(async (session) => {
      items = null;
      const reservation = await this.reservationModel
        .findOneAndUpdate(
          { orderId, status: ReservationStatus.RESERVED },
          { $set: { status: to } },
          { session },
        )
        .lean();
      if (!reservation) return;
      for (const { variantId, cantidad } of reservation.items) {
        await this.variantModel.updateOne(
          { _id: variantId },
          {
            $inc: {
              stockReservado: -cantidad,
              ...(stockDelta !== 0 && { stock: stockDelta * cantidad }),
            },
          },
          { session },
        );
      }
      items = reservation.items.map((i) => ({
        variantId: i.variantId.toString(),
        cantidad: i.cantidad,
      }));
    });
    return items;
  }

  /** Ítems cuya variante no existe o no es apta (`esApta`), con su `disponible`. */
  private async findUnavailable(items: StockItem[]): Promise<RejectedItem[]> {
    const checkout = await this.catalogQuery.getCheckoutVariants(
      items.map((i) => i.variantId),
    );
    const found = new Map(checkout.map((v) => [v.variantId, v]));
    return items.flatMap(({ variantId, cantidad }) => {
      const variant = found.get(variantId);
      return variant?.apta
        ? []
        : [{ variantId, cantidad, disponible: variant?.disponible ?? 0 }];
    });
  }

  /** Agrega el `disponible` actual a los ítems que no alcanzaron. */
  private async withDisponible(failed: StockItem[]): Promise<RejectedItem[]> {
    const current = await this.catalogQuery.getCheckoutVariants(
      failed.map((i) => i.variantId),
    );
    const byId = new Map(current.map((v) => [v.variantId, v.disponible]));
    return failed.map((item) => ({
      ...item,
      disponible: byId.get(item.variantId) ?? 0,
    }));
  }

  /** Segunda transacción: guarda la reserva `REJECTED` y el `eventId`, y emite `stock.rejected`. */
  private async saveRejected(
    event: OrderCreatedEvent,
    items: StockItem[],
    motivo: StockRejectedPayload['motivo'],
    rejected: RejectedItem[],
  ): Promise<void> {
    const { orderId } = event.payload;
    try {
      await this.inTransaction(async (session) => {
        await this.reservationModel.create(
          [{ orderId, status: ReservationStatus.REJECTED, items }],
          { session },
        );
        await this.processedModel.create(
          [{ eventId: event.eventId, type: event.type }],
          { session },
        );
      });
    } catch (error) {
      if (isDuplicateKeyError(error)) return;
      throw error;
    }
    this.emitStock(CatalogEvents.StockRejected, orderId, {
      orderId,
      motivo,
      items: rejected,
    } satisfies StockRejectedPayload);
  }

  /** Corre `fn` en una transacción de Mongo (replica set) y cierra la sesión. */
  private async inTransaction(
    fn: (session: ClientSession) => Promise<void>,
  ): Promise<void> {
    const session = await this.connection.startSession();
    try {
      await session.withTransaction(() => fn(session));
    } finally {
      await session.endSession();
    }
  }

  /** Emite un evento `stock.*` en memoria con el sobre común. */
  private emitStock<TType extends string, TPayload>(
    type: TType,
    orderId: string,
    payload: TPayload,
  ): void {
    this.events.emit(type, {
      eventId: randomUUID(),
      type,
      occurredAt: new Date().toISOString(),
      correlationId: orderId,
      payload,
    } satisfies DomainEvent<TType, TPayload>);
  }
}

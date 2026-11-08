import { BadRequestException, Injectable } from '@nestjs/common';
import { InjectConnection, InjectModel } from '@nestjs/mongoose';
import {
  type ClientSession,
  type Connection,
  type Model,
  Types,
} from 'mongoose';
import { CatalogQueryService } from '../../catalog/index.js';
import {
  OrderEvents,
  type OrderCreatedPayload,
} from '../events/order.events.js';
import { isDuplicateKeyError } from '../policies/duplicate-key.policy.js';
import {
  lineSubtotal,
  orderTotal,
  subtotalsByStore,
} from '../policies/order-totals.policy.js';
import {
  CartItem,
  type CartItemDocument,
} from '../schemas/cart-item.schema.js';
import { Cart, type CartDocument } from '../schemas/cart.schema.js';
import {
  OrderItem,
  type OrderItemDocument,
} from '../schemas/order-item.schema.js';
import {
  Order,
  type OrderDocument,
  OrderStatus,
} from '../schemas/order.schema.js';
import {
  SubOrder,
  type SubOrderDocument,
} from '../schemas/sub-order.schema.js';
import { OutboxService } from './outbox.service.js';

export type OrderItemView = {
  id: string;
  variantId: string;
  productId: string;
  nombreProducto: string;
  presentacion: string;
  unidad: string;
  precioUnitario: number;
  cantidad: number;
  subtotal: number;
};

export type SubOrderView = {
  id: string;
  storeId: string;
  subtotal: number;
  items: OrderItemView[];
};

/** Pedido con sus sub-pedidos e ítems (snapshot del checkout). */
export type OrderView = {
  id: string;
  buyerId: string;
  total: number;
  moneda: 'COP';
  status: OrderStatus;
  expiresAt?: Date;
  createdAt: Date;
  subOrders: SubOrderView[];
};

export type CheckoutResult = {
  order: OrderView;
  /** `false` si la `Idempotency-Key` ya tenía un pedido (se devuelve con 200). */
  created: boolean;
};

export type InvalidCheckoutLine = {
  variantId: string;
  motivo: 'NOT_FOUND' | 'NOT_APTA';
};

/** Checkout: el precio y los datos del ítem salen siempre de `catalog`. */
@Injectable()
export class CheckoutService {
  constructor(
    @InjectConnection() private readonly connection: Connection,
    @InjectModel(Cart.name) private readonly cartModel: Model<CartDocument>,
    @InjectModel(CartItem.name)
    private readonly cartItemModel: Model<CartItemDocument>,
    @InjectModel(Order.name) private readonly orderModel: Model<OrderDocument>,
    @InjectModel(SubOrder.name)
    private readonly subOrderModel: Model<SubOrderDocument>,
    @InjectModel(OrderItem.name)
    private readonly orderItemModel: Model<OrderItemDocument>,
    private readonly catalog: CatalogQueryService,
    private readonly outbox: OutboxService,
  ) {}

  async checkout(
    buyerId: string,
    idempotencyKey: string,
  ): Promise<CheckoutResult> {
    const existing = await this.findByKey(buyerId, idempotencyKey);
    if (existing) return { order: existing, created: false };

    const cart = await this.cartModel.findOne({ buyerId }).lean();
    const lines = cart
      ? await this.cartItemModel
          .find({ cartId: cart._id })
          .sort({ createdAt: 1, _id: 1 })
          .lean()
      : [];
    if (!cart || lines.length === 0) {
      throw new BadRequestException('El carrito está vacío');
    }

    const variants = await this.catalog.getCheckoutVariants(
      lines.map((l) => l.variantId.toString()),
    );
    const byId = new Map(variants.map((v) => [v.variantId, v]));
    const invalid: InvalidCheckoutLine[] = [];
    for (const line of lines) {
      const variantId = line.variantId.toString();
      const v = byId.get(variantId);
      if (!v) invalid.push({ variantId, motivo: 'NOT_FOUND' });
      else if (!v.apta) invalid.push({ variantId, motivo: 'NOT_APTA' });
    }
    if (invalid.length > 0) {
      throw new BadRequestException({
        message: 'El carrito tiene líneas que no se pueden comprar',
        lineas: invalid,
      });
    }

    const priced = lines.map((line) => {
      const v = byId.get(line.variantId.toString())!;
      return {
        variant: v,
        cantidad: line.cantidad,
        storeId: v.storeId,
        precioUnitario: v.precioVigente,
      };
    });
    const subtotals = subtotalsByStore(priced);
    const total = orderTotal(subtotals);

    const orderId = new Types.ObjectId();
    const subOrderIds = new Map(
      subtotals.map((s) => [s.storeId, new Types.ObjectId()]),
    );
    const payload: OrderCreatedPayload = {
      orderId: orderId.toString(),
      items: priced.map((p) => ({
        variantId: p.variant.variantId,
        cantidad: p.cantidad,
      })),
      buyerId,
      total,
    };

    try {
      await this.inTransaction(async (session) => {
        await this.orderModel.create(
          [
            {
              _id: orderId,
              buyerId,
              total,
              moneda: 'COP',
              status: OrderStatus.PENDING,
              idempotencyKey,
            },
          ],
          { session },
        );
        await this.subOrderModel.create(
          subtotals.map((s) => ({
            _id: subOrderIds.get(s.storeId),
            orderId,
            storeId: s.storeId,
            subtotal: s.subtotal,
          })),
          { session, ordered: true },
        );
        await this.orderItemModel.create(
          priced.map((p) => ({
            orderId,
            subOrderId: subOrderIds.get(p.storeId),
            variantId: p.variant.variantId,
            productId: p.variant.productId,
            nombreProducto: p.variant.nombreProducto,
            presentacion: p.variant.presentacion,
            unidad: p.variant.unidad,
            precioUnitario: p.precioUnitario,
            cantidad: p.cantidad,
            subtotal: lineSubtotal(p),
          })),
          { session, ordered: true },
        );
        await this.outbox.add(
          session,
          OrderEvents.OrderCreated,
          orderId.toString(),
          payload,
        );
        await this.cartItemModel.deleteMany({ cartId: cart._id }, { session });
      });
    } catch (error) {
      // Doble clic simultáneo: otra petición creó el pedido con la misma clave.
      if (isDuplicateKeyError(error)) {
        const winner = await this.findByKey(buyerId, idempotencyKey);
        if (winner) return { order: winner, created: false };
      }
      throw error;
    }

    const order = await this.loadOrder(orderId);
    return { order: order!, created: true };
  }

  private async findByKey(
    buyerId: string,
    idempotencyKey: string,
  ): Promise<OrderView | null> {
    const found = await this.orderModel
      .findOne({ buyerId, idempotencyKey })
      .select('_id')
      .lean();
    return found ? this.loadOrder(found._id) : null;
  }

  private async loadOrder(id: Types.ObjectId): Promise<OrderView | null> {
    const order = await this.orderModel.findById(id).lean();
    if (!order) return null;
    const [subOrders, items] = await Promise.all([
      this.subOrderModel.find({ orderId: id }).sort({ _id: 1 }).lean(),
      this.orderItemModel.find({ orderId: id }).sort({ _id: 1 }).lean(),
    ]);
    return {
      id: order._id.toString(),
      buyerId: order.buyerId.toString(),
      total: order.total,
      moneda: order.moneda,
      status: order.status,
      ...(order.expiresAt && { expiresAt: order.expiresAt }),
      createdAt: order.createdAt,
      subOrders: subOrders.map((s) => ({
        id: s._id.toString(),
        storeId: s.storeId.toString(),
        subtotal: s.subtotal,
        items: items
          .filter((i) => i.subOrderId.toString() === s._id.toString())
          .map((i) => ({
            id: i._id.toString(),
            variantId: i.variantId.toString(),
            productId: i.productId.toString(),
            nombreProducto: i.nombreProducto,
            presentacion: i.presentacion,
            unidad: i.unidad,
            precioUnitario: i.precioUnitario,
            cantidad: i.cantidad,
            subtotal: i.subtotal,
          })),
      })),
    };
  }

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
}

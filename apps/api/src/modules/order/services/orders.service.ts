import { Injectable, NotFoundException } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { type Model, type QueryFilter, Types } from 'mongoose';
import type {
  AdminOrdersQuery,
  OrdersQuery,
  ProviderSubOrdersQuery,
} from '../dto/order-query.dto.js';
import { type Page, skipFor, toPage } from '../policies/pagination.policy.js';
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

/** Resumen de un pedido para los listados (sin sub-pedidos ni ítems). */
export type OrderSummaryView = {
  id: string;
  total: number;
  moneda: 'COP';
  status: OrderStatus;
  expiresAt?: Date;
  createdAt: Date;
};

/** Pedido con sus sub-pedidos e ítems (snapshot del checkout). */
export type OrderView = OrderSummaryView & {
  buyerId: string;
  subOrders: SubOrderView[];
};

/** Vista del PROVEEDOR: su `SubOrder` pagado, sin `buyerId`, `total` ni otras tiendas. */
export type ProviderSubOrderView = {
  id: string;
  orderId: string;
  status: OrderStatus;
  subtotal: number;
  createdAt: Date;
  items: OrderItemView[];
};

/** Resumen del ADMIN: el del PRODUCTOR más el comprador. */
export type AdminOrderSummaryView = OrderSummaryView & { buyerId: string };

type StoredOrder = {
  _id: Types.ObjectId;
  buyerId: Types.ObjectId;
  total: number;
  moneda: 'COP';
  status: OrderStatus;
  expiresAt?: Date | null;
  createdAt: Date;
};
type StoredSubOrder = {
  _id: Types.ObjectId;
  storeId: Types.ObjectId;
  subtotal: number;
};
type StoredItem = {
  _id: Types.ObjectId;
  subOrderId: Types.ObjectId;
  variantId: Types.ObjectId;
  productId: Types.ObjectId;
  nombreProducto: string;
  presentacion: string;
  unidad: string;
  precioUnitario: number;
  cantidad: number;
  subtotal: number;
};

export const toOrderSummary = (order: StoredOrder): OrderSummaryView => ({
  id: order._id.toString(),
  total: order.total,
  moneda: order.moneda,
  status: order.status,
  ...(order.expiresAt && { expiresAt: order.expiresAt }),
  createdAt: order.createdAt,
});

export const toOrderItemView = (i: StoredItem): OrderItemView => ({
  id: i._id.toString(),
  variantId: i.variantId.toString(),
  productId: i.productId.toString(),
  nombreProducto: i.nombreProducto,
  presentacion: i.presentacion,
  unidad: i.unidad,
  precioUnitario: i.precioUnitario,
  cantidad: i.cantidad,
  subtotal: i.subtotal,
});

export const toOrderView = (
  order: StoredOrder,
  subOrders: StoredSubOrder[],
  items: StoredItem[],
): OrderView => ({
  ...toOrderSummary(order),
  buyerId: order.buyerId.toString(),
  subOrders: subOrders.map((s) => ({
    id: s._id.toString(),
    storeId: s.storeId.toString(),
    subtotal: s.subtotal,
    items: items
      .filter((i) => i.subOrderId.toString() === s._id.toString())
      .map(toOrderItemView),
  })),
});

const OBJECT_ID = /^[a-f\d]{24}$/i;

const toProviderSubOrderView = (
  s: StoredSubOrder & { orderId: Types.ObjectId; createdAt: Date },
  items: StoredItem[],
): ProviderSubOrderView => ({
  id: s._id.toString(),
  orderId: s.orderId.toString(),
  // Solo se muestran sub-pedidos de pedidos pagados.
  status: OrderStatus.CONFIRMED,
  subtotal: s.subtotal,
  createdAt: s.createdAt,
  items: items
    .filter((i) => i.subOrderId.toString() === s._id.toString())
    .map(toOrderItemView),
});

/** Consulta de pedidos por rol: solo ve los suyos (los ajenos dan `404`). */
@Injectable()
export class OrdersService {
  constructor(
    @InjectModel(Order.name) private readonly orderModel: Model<OrderDocument>,
    @InjectModel(SubOrder.name)
    private readonly subOrderModel: Model<SubOrderDocument>,
    @InjectModel(OrderItem.name)
    private readonly orderItemModel: Model<OrderItemDocument>,
  ) {}

  async listMine(
    buyerId: string,
    query: OrdersQuery,
  ): Promise<Page<OrderSummaryView>> {
    const filter: QueryFilter<OrderDocument> = {
      buyerId,
      ...(query.status && { status: query.status as OrderStatus }),
    };
    const [orders, total] = await Promise.all([
      this.orderModel
        .find(filter)
        .sort({ createdAt: -1, _id: -1 })
        .skip(skipFor(query.page, query.limit))
        .limit(query.limit)
        .lean(),
      this.orderModel.countDocuments(filter),
    ]);
    return toPage(orders.map(toOrderSummary), total, query.page, query.limit);
  }

  /** Pedido propio con sub-pedidos e ítems; ajeno o inexistente: `404`. */
  async getMine(buyerId: string, id: string): Promise<OrderView> {
    const order = await this.orderModel.findOne({ _id: id, buyerId }).lean();
    if (!order) throw new NotFoundException('Pedido no encontrado');
    return this.loadView(order);
  }

  /**
   * Sub-pedidos de la tienda del PROVEEDOR cuyo pedido está `CONFIRMED`.
   * Sin `storeId` (el token no lo trae) devuelve la lista vacía.
   */
  async listProviderSubOrders(
    storeId: string | undefined,
    query: ProviderSubOrdersQuery,
  ): Promise<Page<ProviderSubOrderView>> {
    if (!storeId || !OBJECT_ID.test(storeId)) {
      return toPage([], 0, query.page, query.limit);
    }
    const [result] = await this.subOrderModel.aggregate<{
      data: (StoredSubOrder & { orderId: Types.ObjectId; createdAt: Date })[];
      total: { n: number }[];
    }>([
      { $match: { storeId: new Types.ObjectId(storeId) } },
      {
        $lookup: {
          from: 'orders',
          localField: 'orderId',
          foreignField: '_id',
          as: 'order',
        },
      },
      { $unwind: '$order' },
      { $match: { 'order.status': OrderStatus.CONFIRMED } },
      { $project: { order: 0 } },
      { $sort: { createdAt: -1, _id: -1 } },
      {
        $facet: {
          data: [
            { $skip: skipFor(query.page, query.limit) },
            { $limit: query.limit },
          ],
          total: [{ $count: 'n' }],
        },
      },
    ]);
    const subOrders = result?.data ?? [];
    const items = subOrders.length
      ? await this.orderItemModel
          .find({ subOrderId: { $in: subOrders.map((s) => s._id) } })
          .sort({ _id: 1 })
          .lean()
      : [];
    return toPage(
      subOrders.map((s) => toProviderSubOrderView(s, items)),
      result?.total[0]?.n ?? 0,
      query.page,
      query.limit,
    );
  }

  /** Sub-pedido de la tienda del PROVEEDOR; ajeno, sin pagar o sin tienda: `404`. */
  async getProviderSubOrder(
    storeId: string | undefined,
    id: string,
  ): Promise<ProviderSubOrderView> {
    const subOrder =
      storeId && OBJECT_ID.test(storeId)
        ? await this.subOrderModel.findOne({ _id: id, storeId }).lean()
        : null;
    const paid =
      subOrder &&
      (await this.orderModel.exists({
        _id: subOrder.orderId,
        status: OrderStatus.CONFIRMED,
      }));
    if (!subOrder || !paid) {
      throw new NotFoundException('Sub-pedido no encontrado');
    }
    const items = await this.orderItemModel
      .find({ subOrderId: subOrder._id })
      .sort({ _id: 1 })
      .lean();
    return toProviderSubOrderView(subOrder, items);
  }

  /** Todos los pedidos, solo lectura, con filtros `status` y `buyerId`. */
  async listAll(query: AdminOrdersQuery): Promise<Page<AdminOrderSummaryView>> {
    const filter: QueryFilter<OrderDocument> = {
      ...(query.status && { status: query.status as OrderStatus }),
      ...(query.buyerId && { buyerId: query.buyerId }),
    };
    const [orders, total] = await Promise.all([
      this.orderModel
        .find(filter)
        .sort({ createdAt: -1, _id: -1 })
        .skip(skipFor(query.page, query.limit))
        .limit(query.limit)
        .lean(),
      this.orderModel.countDocuments(filter),
    ]);
    return toPage(
      orders.map((o) => ({
        ...toOrderSummary(o),
        buyerId: o.buyerId.toString(),
      })),
      total,
      query.page,
      query.limit,
    );
  }

  /** Detalle completo de cualquier pedido; inexistente: `404`. */
  async getAny(id: string): Promise<OrderView> {
    const order = await this.orderModel.findById(id).lean();
    if (!order) throw new NotFoundException('Pedido no encontrado');
    return this.loadView(order);
  }

  private async loadView(order: StoredOrder): Promise<OrderView> {
    const [subOrders, items] = await Promise.all([
      this.subOrderModel.find({ orderId: order._id }).sort({ _id: 1 }).lean(),
      this.orderItemModel.find({ orderId: order._id }).sort({ _id: 1 }).lean(),
    ]);
    return toOrderView(order, subOrders, items);
  }
}

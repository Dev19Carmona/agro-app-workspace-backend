import { Injectable, NotFoundException } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import type { Model, QueryFilter, Types } from 'mongoose';
import type { OrdersQuery } from '../dto/order-query.dto.js';
import { type Page, skipFor, toPage } from '../policies/pagination.policy.js';
import {
  OrderItem,
  type OrderItemDocument,
} from '../schemas/order-item.schema.js';
import {
  Order,
  type OrderDocument,
  type OrderStatus,
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

/** Consulta de pedidos del PRODUCTOR: solo ve los suyos (los ajenos dan `404`). */
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
    const [subOrders, items] = await Promise.all([
      this.subOrderModel.find({ orderId: order._id }).sort({ _id: 1 }).lean(),
      this.orderItemModel.find({ orderId: order._id }).sort({ _id: 1 }).lean(),
    ]);
    return toOrderView(order, subOrders, items);
  }
}

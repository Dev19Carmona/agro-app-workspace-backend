import { Injectable } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import type { Model } from 'mongoose';
import {
  Order,
  type OrderDocument,
  type OrderStatus,
} from '../schemas/order.schema.js';

/** Lo que `payments` necesita del pedido: el monto sale siempre de aquí. */
export type OrderForPayment = {
  orderId: string;
  buyerId: string;
  /** Monto a cobrar. */
  total: number;
  moneda: 'COP';
  status: OrderStatus;
  expiresAt: Date | null;
};

const OBJECT_ID = /^[a-f\d]{24}$/i;

/** API pública de `order` para otros módulos (`index.ts`). */
@Injectable()
export class OrderQueryService {
  constructor(
    @InjectModel(Order.name) private readonly orderModel: Model<OrderDocument>,
  ) {}

  /**
   * `null` si el pedido no existe o no pertenece a `buyerId`. `payments` debe
   * tratar `null` como `404` y cualquier `status` distinto de
   * `AWAITING_PAYMENT` como error de pago.
   */
  async getOrderForPayment(
    orderId: string,
    buyerId: string,
  ): Promise<OrderForPayment | null> {
    if (!OBJECT_ID.test(orderId) || !OBJECT_ID.test(buyerId)) return null;
    const order = await this.orderModel
      .findOne({ _id: orderId, buyerId })
      .lean();
    if (!order) return null;
    return {
      orderId: order._id.toString(),
      buyerId: order.buyerId.toString(),
      total: order.total,
      moneda: order.moneda,
      status: order.status,
      expiresAt: order.expiresAt ?? null,
    };
  }
}

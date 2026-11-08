import {
  BadRequestException,
  ConflictException,
  Injectable,
} from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import type { Model, Types } from 'mongoose';
import { CatalogQueryService } from '../../catalog/index.js';
import { MAX_CART_LINES } from '../dto/cart.dto.js';
import { isDuplicateKeyError } from '../policies/duplicate-key.policy.js';
import { lineSubtotal, orderTotal } from '../policies/order-totals.policy.js';
import {
  CartItem,
  type CartItemDocument,
} from '../schemas/cart-item.schema.js';
import { Cart, type CartDocument } from '../schemas/cart.schema.js';

export type CartLineView = { variantId: string; cantidad: number };

/**
 * Línea del carrito con los datos actuales de `catalog`. Si la variante ya no
 * existe, solo trae `variantId`, `cantidad`, `disponible: 0` y `apta: false`.
 */
export type CartItemView = CartLineView & {
  productId?: string;
  storeId?: string;
  nombreProducto?: string;
  presentacion?: string;
  unidad?: string;
  precioVigente?: number;
  disponible: number;
  apta: boolean;
};

/** `total` es informativo: suma solo las líneas `apta`. El checkout recalcula. */
export type CartView = { items: CartItemView[]; total: number };

/** Carrito del PRODUCTOR: un carrito por usuario, solo referencias a variantes. */
@Injectable()
export class CartService {
  constructor(
    @InjectModel(Cart.name) private readonly cartModel: Model<CartDocument>,
    @InjectModel(CartItem.name)
    private readonly itemModel: Model<CartItemDocument>,
    private readonly catalog: CatalogQueryService,
  ) {}

  /** Carrito con `precioVigente`, `disponible` y `apta` actuales. Sin carrito: lista vacía. */
  async get(buyerId: string): Promise<CartView> {
    const cart = await this.cartModel.findOne({ buyerId }).lean();
    if (!cart) return { items: [], total: 0 };

    const lines = await this.itemModel
      .find({ cartId: cart._id })
      .sort({ createdAt: 1, _id: 1 })
      .lean();
    const variants = await this.catalog.getCheckoutVariants(
      lines.map((l) => l.variantId.toString()),
    );
    const byId = new Map(variants.map((v) => [v.variantId, v]));

    const items = lines.map((line): CartItemView => {
      const variantId = line.variantId.toString();
      const v = byId.get(variantId);
      if (!v)
        return {
          variantId,
          cantidad: line.cantidad,
          disponible: 0,
          apta: false,
        };
      return { ...v, cantidad: line.cantidad };
    });
    const total = orderTotal(
      items
        .filter((i) => i.apta)
        .map((i) => ({
          subtotal: lineSubtotal({
            precioUnitario: i.precioVigente ?? 0,
            cantidad: i.cantidad,
          }),
        })),
    );
    return { items, total };
  }

  /**
   * Fija la cantidad (valor absoluto) de una variante; crea el carrito si no
   * existe. `400` si la variante no existe o no es `apta`, o si el carrito ya
   * tiene 50 líneas y la variante es nueva.
   */
  async setItem(
    buyerId: string,
    variantId: string,
    cantidad: number,
  ): Promise<CartLineView> {
    const [variant] = await this.catalog.getCheckoutVariants([variantId]);
    if (!variant) throw new BadRequestException('La variante no existe');
    if (!variant.apta) {
      throw new BadRequestException(
        'La variante no está disponible para compra',
      );
    }

    const cart = await this.getOrCreateCart(buyerId);
    const filter = { cartId: cart._id, variantId };
    const exists = await this.itemModel.exists(filter);
    if (
      !exists &&
      (await this.itemModel.countDocuments({ cartId: cart._id })) >=
        MAX_CART_LINES
    ) {
      throw new BadRequestException(
        `El carrito admite máximo ${MAX_CART_LINES} líneas`,
      );
    }

    try {
      await this.itemModel.findOneAndUpdate(
        filter,
        { $set: { cantidad } },
        { upsert: true },
      );
    } catch (error) {
      if (isDuplicateKeyError(error)) {
        throw new ConflictException(
          'El carrito cambió al mismo tiempo; reintenta',
        );
      }
      throw error;
    }
    return { variantId: variant.variantId, cantidad };
  }

  /** Idempotente: no falla si la línea o el carrito no existen. */
  async removeItem(buyerId: string, variantId: string): Promise<void> {
    const cart = await this.cartModel.findOne({ buyerId }).lean();
    if (!cart) return;
    await this.itemModel.deleteOne({ cartId: cart._id, variantId });
  }

  /** Vacía el carrito; el carrito en sí se conserva. */
  async clear(buyerId: string): Promise<void> {
    const cart = await this.cartModel.findOne({ buyerId }).lean();
    if (!cart) return;
    await this.itemModel.deleteMany({ cartId: cart._id });
  }

  private async getOrCreateCart(
    buyerId: string,
  ): Promise<{ _id: Types.ObjectId }> {
    try {
      return await this.cartModel
        .findOneAndUpdate(
          { buyerId },
          { $setOnInsert: { buyerId } },
          { upsert: true, returnDocument: 'after' },
        )
        .lean();
    } catch (error) {
      if (!isDuplicateKeyError(error)) throw error;
      // Otra petición creó el carrito entre el find y el insert del upsert.
      const cart = await this.cartModel.findOne({ buyerId }).lean();
      if (!cart) throw error;
      return cart;
    }
  }
}

import {
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { type Model } from 'mongoose';
import {
  ProductVariant,
  type ProductVariantDocument,
} from '../schemas/product-variant.schema.js';
import { Product, type ProductDocument } from '../schemas/product.schema.js';
import { Store, type StoreDocument } from '../schemas/store.schema.js';
import { type VariantView, toVariantView } from './products.service.js';

@Injectable()
export class StockService {
  constructor(
    @InjectModel(Store.name) private readonly storeModel: Model<StoreDocument>,
    @InjectModel(Product.name)
    private readonly productModel: Model<ProductDocument>,
    @InjectModel(ProductVariant.name)
    private readonly variantModel: Model<ProductVariantDocument>,
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
}

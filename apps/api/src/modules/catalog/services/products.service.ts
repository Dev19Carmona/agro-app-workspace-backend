import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { type Model, type Types } from 'mongoose';
import type { CreateProductDto, UpdateProductDto } from '../dto/product.dto.js';
import type { CreateVariantDto, UpdateVariantDto } from '../dto/variant.dto.js';
import { disponible, precioVigente } from '../policies/pricing.policy.js';
import { Category, type CategoryDocument } from '../schemas/category.schema.js';
import {
  ProductVariant,
  type ProductVariantDocument,
} from '../schemas/product-variant.schema.js';
import { Product, type ProductDocument } from '../schemas/product.schema.js';
import { Store, type StoreDocument } from '../schemas/store.schema.js';

export type ProductView = {
  id: string;
  storeId: string;
  categoryId: string;
  nombre: string;
  marca: string;
  fichaTecnica: Record<string, string>;
  requiresQuote: boolean;
  activo: boolean;
};

export type VariantView = {
  id: string;
  productId: string;
  presentacion: string;
  unidad: string;
  precio: number;
  precioOferta?: number;
  precioVigente: number;
  stock: number;
  stockReservado: number;
  disponible: number;
  activo: boolean;
};

type StoredProduct = Pick<
  Product,
  'nombre' | 'marca' | 'fichaTecnica' | 'requiresQuote' | 'activo'
> & {
  _id: Types.ObjectId;
  storeId: Types.ObjectId;
  categoryId: Types.ObjectId;
};

type StoredVariant = Pick<
  ProductVariant,
  | 'presentacion'
  | 'unidad'
  | 'precio'
  | 'precioOferta'
  | 'stock'
  | 'stockReservado'
  | 'activo'
> & { _id: Types.ObjectId; productId: Types.ObjectId };

export const toProductView = (p: StoredProduct): ProductView => ({
  id: p._id.toString(),
  storeId: p.storeId.toString(),
  categoryId: p.categoryId.toString(),
  nombre: p.nombre,
  marca: p.marca,
  fichaTecnica: p.fichaTecnica,
  requiresQuote: p.requiresQuote,
  activo: p.activo,
});

export const toVariantView = (v: StoredVariant): VariantView => ({
  id: v._id.toString(),
  productId: v.productId.toString(),
  presentacion: v.presentacion,
  unidad: v.unidad,
  precio: v.precio,
  ...(v.precioOferta != null && { precioOferta: v.precioOferta }),
  precioVigente: precioVigente(v),
  stock: v.stock,
  stockReservado: v.stockReservado,
  disponible: disponible(v),
  activo: v.activo,
});

/**
 * Productos y variantes del PROVEEDOR. Toda operación resuelve su tienda con
 * `ownerId = user.id` (el claim `storeId` del token no se usa para autorizar).
 */
@Injectable()
export class ProductsService {
  constructor(
    @InjectModel(Store.name) private readonly storeModel: Model<StoreDocument>,
    @InjectModel(Category.name)
    private readonly categoryModel: Model<CategoryDocument>,
    @InjectModel(Product.name)
    private readonly productModel: Model<ProductDocument>,
    @InjectModel(ProductVariant.name)
    private readonly variantModel: Model<ProductVariantDocument>,
  ) {}

  /** Crea un producto en la tienda del PROVEEDOR; `storeId` nunca viene del body. */
  async createProduct(
    ownerId: string,
    dto: CreateProductDto,
  ): Promise<ProductView> {
    const store = await this.requireStore(ownerId);
    if (!store.activa) {
      throw new ForbiddenException('Tu tienda está desactivada');
    }
    await this.assertCategoryActive(dto.categoryId);
    const created = await this.productModel.create({
      ...dto,
      storeId: store._id,
    });
    return toProductView(created);
  }

  /** Edita un producto propio; uno ajeno responde 404. */
  async updateProduct(
    ownerId: string,
    productId: string,
    dto: UpdateProductDto,
  ): Promise<ProductView> {
    const store = await this.requireStore(ownerId);
    if (dto.categoryId) await this.assertCategoryActive(dto.categoryId);
    const updated = await this.productModel
      .findOneAndUpdate(
        { _id: productId, storeId: store._id },
        { $set: dto },
        { new: true },
      )
      .lean();
    if (!updated) throw this.productNotFound();
    return toProductView(updated);
  }

  /** Crea una variante de un producto propio; `stockReservado` nace en 0. */
  async createVariant(
    ownerId: string,
    productId: string,
    dto: CreateVariantDto,
  ): Promise<VariantView> {
    const store = await this.requireStore(ownerId);
    await this.assertOwnsProduct(productId, store._id);
    const created = await this.variantModel.create({ ...dto, productId });
    return toVariantView(created);
  }

  /**
   * Edita precio, oferta, textos o `activo` de una variante propia. No toca
   * `stock` ni `stockReservado`. `precioOferta: null` quita la oferta.
   */
  async updateVariant(
    ownerId: string,
    variantId: string,
    dto: UpdateVariantDto,
  ): Promise<VariantView> {
    const store = await this.requireStore(ownerId);
    const variant = await this.variantModel.findById(variantId).lean();
    if (!variant) throw this.variantNotFound();
    await this.assertOwnsProduct(variant.productId, store._id, true);

    const precio = dto.precio ?? variant.precio;
    const oferta =
      dto.precioOferta === undefined ? variant.precioOferta : dto.precioOferta;
    if (oferta != null && oferta >= precio) {
      throw new BadRequestException('precioOferta debe ser menor que precio');
    }

    const { precioOferta, ...resto } = dto;
    const update = {
      $set: {
        ...resto,
        ...(typeof precioOferta === 'number' && { precioOferta }),
      },
      ...(precioOferta === null && { $unset: { precioOferta: '' as const } }),
    };
    const updated = await this.variantModel
      .findByIdAndUpdate(variantId, update, { new: true })
      .lean();
    if (!updated) throw this.variantNotFound();
    return toVariantView(updated);
  }

  /** Tienda del PROVEEDOR por `ownerId`; sin tienda, 403. */
  private async requireStore(ownerId: string) {
    const store = await this.storeModel.findOne({ ownerId }).lean();
    if (!store) throw new ForbiddenException('Aún no tienes una tienda');
    return store;
  }

  /** La categoría debe existir y estar activa; si no, 400. */
  private async assertCategoryActive(categoryId: string): Promise<void> {
    const exists = await this.categoryModel.exists({
      _id: categoryId,
      activa: true,
    });
    if (!exists) {
      throw new BadRequestException('La categoría no existe o está inactiva');
    }
  }

  /** Un producto de otra tienda responde 404, igual que uno inexistente. */
  private async assertOwnsProduct(
    productId: string | Types.ObjectId,
    storeId: Types.ObjectId,
    forVariant = false,
  ): Promise<void> {
    const owns = await this.productModel.exists({ _id: productId, storeId });
    if (!owns) {
      throw forVariant ? this.variantNotFound() : this.productNotFound();
    }
  }

  private productNotFound(): NotFoundException {
    return new NotFoundException('Producto no encontrado');
  }

  private variantNotFound(): NotFoundException {
    return new NotFoundException('Variante no encontrada');
  }
}

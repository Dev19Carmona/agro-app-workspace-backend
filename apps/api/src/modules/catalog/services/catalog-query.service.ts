import { Injectable, NotFoundException } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { type Model, type QueryFilter, type Types } from 'mongoose';
import type { ProductsQuery, StoresQuery } from '../dto/catalog-query.dto.js';
import { type Page, toPage } from '../policies/pagination.policy.js';
import {
  disponible,
  esApta,
  precioVigente,
} from '../policies/pricing.policy.js';
import { Category, type CategoryDocument } from '../schemas/category.schema.js';
import {
  ProductVariant,
  type ProductVariantDocument,
} from '../schemas/product-variant.schema.js';
import { Product, type ProductDocument } from '../schemas/product.schema.js';
import { Store, type StoreDocument } from '../schemas/store.schema.js';
import { type ProductView, toProductView } from './products.service.js';

/** Variante tal como la ve el público: sin `stock` ni `stockReservado`. */
export type PublicVariantView = {
  id: string;
  productId: string;
  presentacion: string;
  unidad: string;
  precio: number;
  precioOferta?: number;
  precioVigente: number;
  disponible: number;
};

export type PublicProductDetail = ProductView & {
  variantes: PublicVariantView[];
};

/** Tienda tal como la ve el público: sin `ownerId` ni `nit`. */
export type PublicStoreView = {
  id: string;
  nombre: string;
  municipio: string;
};

export type PublicCategoryView = { id: string; nombre: string };

/** Lo que `order` necesita de una variante en el checkout (el precio sale siempre del catálogo). */
export type CheckoutVariant = {
  variantId: string;
  productId: string;
  storeId: string;
  nombreProducto: string;
  presentacion: string;
  unidad: string;
  precioVigente: number;
  disponible: number;
  /** `false` si requiere cotización, está inactiva o su tienda está desactivada. */
  apta: boolean;
};

const OBJECT_ID = /^[a-f\d]{24}$/i;

type StoredVariant = Pick<
  ProductVariant,
  | 'presentacion'
  | 'unidad'
  | 'precio'
  | 'precioOferta'
  | 'stock'
  | 'stockReservado'
> & { _id: Types.ObjectId; productId: Types.ObjectId };

const toPublicVariant = (v: StoredVariant): PublicVariantView => ({
  id: v._id.toString(),
  productId: v.productId.toString(),
  presentacion: v.presentacion,
  unidad: v.unidad,
  precio: v.precio,
  ...(v.precioOferta != null && { precioOferta: v.precioOferta }),
  precioVigente: precioVigente(v),
  disponible: disponible(v),
});

const toPublicStore = (s: {
  _id: Types.ObjectId;
  nombre: string;
  municipio: string;
}): PublicStoreView => ({
  id: s._id.toString(),
  nombre: s.nombre,
  municipio: s.municipio,
});

/** Consulta pública del catálogo. Solo ve lo activo y de tiendas activas. */
@Injectable()
export class CatalogQueryService {
  constructor(
    @InjectModel(Store.name) private readonly storeModel: Model<StoreDocument>,
    @InjectModel(Category.name)
    private readonly categoryModel: Model<CategoryDocument>,
    @InjectModel(Product.name)
    private readonly productModel: Model<ProductDocument>,
    @InjectModel(ProductVariant.name)
    private readonly variantModel: Model<ProductVariantDocument>,
  ) {}

  /**
   * API pública para `order`. Una variante inexistente (o con un id que no es
   * ObjectId) no aparece en el resultado: `order` debe tratar su ausencia o
   * `apta = false` como error de checkout. Respeta el orden pedido, sin repetir.
   */
  async getCheckoutVariants(variantIds: string[]): Promise<CheckoutVariant[]> {
    const ids = [...new Set(variantIds)].filter((id) => OBJECT_ID.test(id));
    if (ids.length === 0) return [];

    const variants = await this.variantModel.find({ _id: { $in: ids } }).lean();
    const products = await this.productModel
      .find({ _id: { $in: variants.map((v) => v.productId) } })
      .lean();
    const productById = new Map(products.map((p) => [p._id.toString(), p]));
    const stores = await this.storeModel
      .find({ _id: { $in: products.map((p) => p.storeId) } })
      .lean();
    const storeById = new Map(stores.map((s) => [s._id.toString(), s]));
    const variantById = new Map(variants.map((v) => [v._id.toString(), v]));

    const result: CheckoutVariant[] = [];
    for (const id of ids) {
      const variant = variantById.get(id.toLowerCase());
      const product = variant && productById.get(variant.productId.toString());
      const store = product && storeById.get(product.storeId.toString());
      if (!variant || !product || !store) continue;
      result.push({
        variantId: variant._id.toString(),
        productId: product._id.toString(),
        storeId: store._id.toString(),
        nombreProducto: product.nombre,
        presentacion: variant.presentacion,
        unidad: variant.unidad,
        precioVigente: precioVigente(variant),
        disponible: disponible(variant),
        apta: esApta(variant, product, store),
      });
    }
    return result;
  }

  async listProducts(query: ProductsQuery): Promise<Page<ProductView>> {
    const filter = await this.productFilter(query);
    const [products, total] = await Promise.all([
      this.productModel
        .find(filter)
        .sort({ createdAt: -1, _id: -1 })
        .skip((query.page - 1) * query.limit)
        .limit(query.limit)
        .lean(),
      this.productModel.countDocuments(filter),
    ]);
    return toPage(products.map(toProductView), total, query.page, query.limit);
  }

  /** Producto con sus variantes activas; una sin stock sale con `disponible: 0`. */
  async getProduct(id: string): Promise<PublicProductDetail> {
    const product = await this.productModel
      .findOne({ _id: id, activo: true })
      .lean();
    const store =
      product &&
      (await this.storeModel.exists({ _id: product.storeId, activa: true }));
    if (!product || !store)
      throw new NotFoundException('Producto no encontrado');

    const variants = await this.variantModel
      .find({ productId: product._id, activo: true })
      .sort({ _id: 1 })
      .lean();
    return {
      ...toProductView(product),
      variantes: variants.map(toPublicVariant),
    };
  }

  /** Variantes activas con `precioOferta` de productos activos y sin cotización. */
  async listOffers(query: ProductsQuery): Promise<Page<PublicVariantView>> {
    const productIds = await this.productModel.distinct('_id', {
      ...(await this.productFilter(query)),
      requiresQuote: false,
    });
    const filter: QueryFilter<ProductVariantDocument> = {
      activo: true,
      precioOferta: { $exists: true },
      productId: { $in: productIds },
    };
    const [variants, total] = await Promise.all([
      this.variantModel
        .find(filter)
        .sort({ createdAt: -1, _id: -1 })
        .skip((query.page - 1) * query.limit)
        .limit(query.limit)
        .lean(),
      this.variantModel.countDocuments(filter),
    ]);
    return toPage(
      variants.map(toPublicVariant),
      total,
      query.page,
      query.limit,
    );
  }

  async listStores(query: StoresQuery): Promise<Page<PublicStoreView>> {
    const filter: QueryFilter<StoreDocument> = {
      activa: true,
      ...(query.municipio && { municipio: query.municipio }),
    };
    const [stores, total] = await Promise.all([
      this.storeModel
        .find(filter)
        .sort({ createdAt: -1, _id: -1 })
        .skip((query.page - 1) * query.limit)
        .limit(query.limit)
        .lean(),
      this.storeModel.countDocuments(filter),
    ]);
    return toPage(stores.map(toPublicStore), total, query.page, query.limit);
  }

  async getStore(id: string): Promise<PublicStoreView> {
    const store = await this.storeModel
      .findOne({ _id: id, activa: true })
      .lean();
    if (!store) throw new NotFoundException('Tienda no encontrada');
    return toPublicStore(store);
  }

  async listCategories(): Promise<PublicCategoryView[]> {
    const categories = await this.categoryModel
      .find({ activa: true })
      .sort({ nombre: 1 })
      .lean();
    return categories.map((c) => ({ id: c._id.toString(), nombre: c.nombre }));
  }

  /**
   * Filtro de productos visibles: activos y de tiendas activas (con los
   * filtros `storeId` y `municipio` aplicados sobre la tienda).
   */
  private async productFilter(
    query: ProductsQuery,
  ): Promise<QueryFilter<ProductDocument>> {
    const storeIds = await this.storeModel.distinct('_id', {
      activa: true,
      ...(query.storeId && { _id: query.storeId }),
      ...(query.municipio && { municipio: query.municipio }),
    });
    return {
      activo: true,
      storeId: { $in: storeIds },
      ...(query.categoryId && { categoryId: query.categoryId }),
    };
  }
}

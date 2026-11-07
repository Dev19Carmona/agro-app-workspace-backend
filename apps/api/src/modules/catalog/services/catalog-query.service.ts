import { Injectable, NotFoundException } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { type Model, type QueryFilter, type Types } from 'mongoose';
import type { ProductsQuery, StoresQuery } from '../dto/catalog-query.dto.js';
import { type Page, toPage } from '../policies/pagination.policy.js';
import { disponible, precioVigente } from '../policies/pricing.policy.js';
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

import { Controller, Get, Param, Query } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { Public } from '../../../../../../libs/common/src/security/decorators.js';
import {
  objectIdSchema,
  type ProductsQuery,
  productsQuerySchema,
  type StoresQuery,
  storesQuerySchema,
} from '../dto/catalog-query.dto.js';
import type { Page } from '../policies/pagination.policy.js';
import {
  CatalogQueryService,
  type PublicCategoryView,
  type PublicProductDetail,
  type PublicStoreView,
  type PublicVariantView,
} from '../services/catalog-query.service.js';
import type { ProductView } from '../services/products.service.js';

/** Consulta pública del catálogo: sin token. */
@ApiTags('catalog')
@Controller('catalog')
export class CatalogPublicController {
  constructor(private readonly catalog: CatalogQueryService) {}

  @Public()
  @Get('products')
  @ApiOperation({ summary: 'Lista productos activos de tiendas activas.' })
  listProducts(
    @Query({ schema: productsQuerySchema }) query: ProductsQuery,
  ): Promise<Page<ProductView>> {
    return this.catalog.listProducts(query);
  }

  @Public()
  @Get('products/:id')
  @ApiOperation({
    summary: 'Producto con sus variantes activas, precio vigente y disponible.',
  })
  getProduct(
    @Param('id', { schema: objectIdSchema }) id: string,
  ): Promise<PublicProductDetail> {
    return this.catalog.getProduct(id);
  }

  @Public()
  @Get('offers')
  @ApiOperation({ summary: 'Variantes activas con precio de oferta.' })
  listOffers(
    @Query({ schema: productsQuerySchema }) query: ProductsQuery,
  ): Promise<Page<PublicVariantView>> {
    return this.catalog.listOffers(query);
  }

  @Public()
  @Get('stores')
  @ApiOperation({ summary: 'Lista las tiendas activas.' })
  listStores(
    @Query({ schema: storesQuerySchema }) query: StoresQuery,
  ): Promise<Page<PublicStoreView>> {
    return this.catalog.listStores(query);
  }

  @Public()
  @Get('stores/:id')
  @ApiOperation({ summary: 'Detalle de una tienda activa.' })
  getStore(
    @Param('id', { schema: objectIdSchema }) id: string,
  ): Promise<PublicStoreView> {
    return this.catalog.getStore(id);
  }

  @Public()
  @Get('categories')
  @ApiOperation({ summary: 'Lista las categorías activas.' })
  listCategories(): Promise<PublicCategoryView[]> {
    return this.catalog.listCategories();
  }
}

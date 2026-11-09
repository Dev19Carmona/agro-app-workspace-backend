import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  Patch,
  Post,
  Query,
} from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import {
  CurrentUser,
  Roles,
} from '../../../../../../libs/common/src/security/decorators.js';
import {
  type AuthenticatedUser,
  Role,
} from '../../../../../../libs/common/src/security/roles.js';
import {
  type MyProductsQuery,
  myProductsQuerySchema,
  objectIdSchema,
} from '../dto/catalog-query.dto.js';
import {
  type CreateProductDto,
  createProductSchema,
  type UpdateProductDto,
  updateProductSchema,
} from '../dto/product.dto.js';
import { type CreateStoreDto, createStoreSchema } from '../dto/store.dto.js';
import {
  type CreateVariantDto,
  createVariantSchema,
  type SetStockDto,
  setStockSchema,
  type UpdateVariantDto,
  updateVariantSchema,
} from '../dto/variant.dto.js';
import type { Page } from '../policies/pagination.policy.js';
import {
  type MyProductView,
  type ProductView,
  ProductsService,
  type VariantView,
} from '../services/products.service.js';
import { StockService } from '../services/stock.service.js';
import { type StoreView, StoresService } from '../services/stores.service.js';

/** Tienda, productos, variantes y stock del PROVEEDOR, solo sobre su tienda. */
@ApiTags('catalog')
@ApiBearerAuth()
@Roles(Role.PROVEEDOR)
@Controller('catalog')
export class ProviderCatalogController {
  constructor(
    private readonly stores: StoresService,
    private readonly products: ProductsService,
    private readonly stock: StockService,
  ) {}

  @Post('stores')
  @HttpCode(HttpStatus.CREATED)
  @ApiOperation({
    summary: 'Crea la tienda del PROVEEDOR (una por proveedor).',
  })
  createStore(
    @CurrentUser() user: AuthenticatedUser,
    @Body({ schema: createStoreSchema }) dto: CreateStoreDto,
  ): Promise<StoreView> {
    return this.stores.create(user.id, dto);
  }

  @Post('products')
  @HttpCode(HttpStatus.CREATED)
  @ApiOperation({ summary: 'Crea un producto en la tienda del PROVEEDOR.' })
  createProduct(
    @CurrentUser() user: AuthenticatedUser,
    @Body({ schema: createProductSchema }) dto: CreateProductDto,
  ): Promise<ProductView> {
    return this.products.createProduct(user.id, dto);
  }

  @Patch('products/:id')
  @ApiOperation({ summary: 'Edita un producto propio.' })
  updateProduct(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id', { schema: objectIdSchema }) id: string,
    @Body({ schema: updateProductSchema }) dto: UpdateProductDto,
  ): Promise<ProductView> {
    return this.products.updateProduct(user.id, id, dto);
  }

  @Post('products/:id/variants')
  @HttpCode(HttpStatus.CREATED)
  @ApiOperation({ summary: 'Crea una variante de un producto propio.' })
  createVariant(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id', { schema: objectIdSchema }) id: string,
    @Body({ schema: createVariantSchema }) dto: CreateVariantDto,
  ): Promise<VariantView> {
    return this.products.createVariant(user.id, id, dto);
  }

  @Patch('variants/:id')
  @ApiOperation({
    summary: 'Edita una variante propia (no toca stock ni reservas).',
  })
  updateVariant(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id', { schema: objectIdSchema }) id: string,
    @Body({ schema: updateVariantSchema }) dto: UpdateVariantDto,
  ): Promise<VariantView> {
    return this.products.updateVariant(user.id, id, dto);
  }

  @Patch('variants/:id/stock')
  @ApiOperation({
    summary: 'Fija el stock (valor absoluto); 409 si queda bajo lo reservado.',
  })
  setStock(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id', { schema: objectIdSchema }) id: string,
    @Body({ schema: setStockSchema }) dto: SetStockDto,
  ): Promise<VariantView> {
    return this.stock.setStock(user.id, id, dto.stock);
  }

  @Get('my-store')
  @ApiOperation({ summary: 'Tienda del PROVEEDOR autenticado.' })
  myStore(@CurrentUser() user: AuthenticatedUser): Promise<StoreView> {
    return this.stores.getMine(user.id);
  }

  @Get('my-store/products')
  @ApiOperation({
    summary:
      'Productos de la tienda propia (activos e inactivos) con sus variantes, stock y reservado.',
  })
  myProducts(
    @CurrentUser() user: AuthenticatedUser,
    @Query({ schema: myProductsQuerySchema }) query: MyProductsQuery,
  ): Promise<Page<MyProductView>> {
    return this.products.listMine(user.id, query);
  }
}

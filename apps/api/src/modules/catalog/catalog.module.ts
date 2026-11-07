import { Module } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';
import { CatalogAdminController } from './controllers/catalog-admin.controller.js';
import { CatalogPublicController } from './controllers/catalog-public.controller.js';
import { ProviderCatalogController } from './controllers/provider-catalog.controller.js';
import { Category, CategorySchema } from './schemas/category.schema.js';
import {
  ProcessedEvent,
  ProcessedEventSchema,
} from './schemas/processed-event.schema.js';
import {
  ProductVariant,
  ProductVariantSchema,
} from './schemas/product-variant.schema.js';
import { Product, ProductSchema } from './schemas/product.schema.js';
import {
  StockReservation,
  StockReservationSchema,
} from './schemas/stock-reservation.schema.js';
import { Store, StoreSchema } from './schemas/store.schema.js';
import { CatalogQueryService } from './services/catalog-query.service.js';
import { CategoriesService } from './services/categories.service.js';
import { ProductsService } from './services/products.service.js';
import { StockService } from './services/stock.service.js';
import { StoresService } from './services/stores.service.js';

@Module({
  imports: [
    MongooseModule.forFeature([
      { name: Store.name, schema: StoreSchema },
      { name: Category.name, schema: CategorySchema },
      { name: Product.name, schema: ProductSchema },
      { name: ProductVariant.name, schema: ProductVariantSchema },
      { name: StockReservation.name, schema: StockReservationSchema },
      { name: ProcessedEvent.name, schema: ProcessedEventSchema },
    ]),
  ],
  controllers: [
    CatalogPublicController,
    ProviderCatalogController,
    CatalogAdminController,
  ],
  providers: [
    CatalogQueryService,
    StoresService,
    CategoriesService,
    ProductsService,
    StockService,
  ],
})
export class CatalogModule {}

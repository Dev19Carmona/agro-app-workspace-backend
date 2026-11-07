import { Module } from '@nestjs/common';
import { CatalogController } from './controllers/catalog.controller.js';
import { CatalogService } from './services/catalog.service.js';

@Module({
  imports: [],
  controllers: [CatalogController],
  providers: [CatalogService],
})
export class CatalogModule {}

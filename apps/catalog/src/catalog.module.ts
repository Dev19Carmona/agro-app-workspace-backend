import { Module } from '@nestjs/common';
import { CatalogController } from './catalog.controller.js';
import { CatalogService } from './catalog.service.js';

@Module({
  imports: [],
  controllers: [CatalogController],
  providers: [CatalogService],
})
export class CatalogModule {}

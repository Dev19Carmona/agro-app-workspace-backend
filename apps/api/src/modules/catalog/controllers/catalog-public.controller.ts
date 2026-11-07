import { ApiTags } from '@nestjs/swagger';
import { Controller, Get } from '@nestjs/common';
import { CatalogService } from '../services/catalog.service.js';

@ApiTags('catalog')
@Controller('catalog')
export class CatalogController {
  constructor(private readonly catalogService: CatalogService) {}

  @Get()
  getHello(): string {
    return this.catalogService.getHello();
  }
}

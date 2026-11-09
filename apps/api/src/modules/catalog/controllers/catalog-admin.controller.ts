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
import { Roles } from '../../../../../../libs/common/src/security/decorators.js';
import { Role } from '../../../../../../libs/common/src/security/roles.js';
import {
  objectIdSchema,
  type StoresQuery,
  storesQuerySchema,
} from '../dto/catalog-query.dto.js';
import {
  type CreateCategoryDto,
  createCategorySchema,
  type UpdateCategoryDto,
  updateCategorySchema,
} from '../dto/category.dto.js';
import { type UpdateStoreDto, updateStoreSchema } from '../dto/store.dto.js';
import type { Page } from '../policies/pagination.policy.js';
import {
  type CategoryView,
  CategoriesService,
} from '../services/categories.service.js';
import { type StoreView, StoresService } from '../services/stores.service.js';

/** Categorías y tiendas del ADMIN. No toca productos ni stock. */
@ApiTags('catalog')
@ApiBearerAuth()
@Roles(Role.ADMIN)
@Controller('catalog')
export class CatalogAdminController {
  constructor(
    private readonly categories: CategoriesService,
    private readonly stores: StoresService,
  ) {}

  @Get('admin/categories')
  @ApiOperation({
    summary: 'Lista todas las categorías, desactivadas incluidas.',
  })
  listCategories(): Promise<CategoryView[]> {
    return this.categories.listAdmin();
  }

  @Post('categories')
  @HttpCode(HttpStatus.CREATED)
  @ApiOperation({ summary: 'Crea una categoría.' })
  createCategory(
    @Body({ schema: createCategorySchema }) dto: CreateCategoryDto,
  ): Promise<CategoryView> {
    return this.categories.create(dto);
  }

  @Patch('categories/:id')
  @ApiOperation({
    summary: 'Edita el nombre o activa/desactiva una categoría.',
  })
  updateCategory(
    @Param('id', { schema: objectIdSchema }) id: string,
    @Body({ schema: updateCategorySchema }) dto: UpdateCategoryDto,
  ): Promise<CategoryView> {
    return this.categories.update(id, dto);
  }

  @Get('admin/stores')
  @ApiOperation({ summary: 'Lista las tiendas, desactivadas incluidas.' })
  listStores(
    @Query({ schema: storesQuerySchema }) query: StoresQuery,
  ): Promise<Page<StoreView>> {
    return this.stores.listAdmin(query);
  }

  @Get('admin/stores/:id')
  @ApiOperation({ summary: 'Detalle de una tienda, activa o no.' })
  findStore(
    @Param('id', { schema: objectIdSchema }) id: string,
  ): Promise<StoreView> {
    return this.stores.findOneAdmin(id);
  }

  @Patch('admin/stores/:id')
  @ApiOperation({ summary: 'Edita nombre, NIT o municipio de una tienda.' })
  updateStore(
    @Param('id', { schema: objectIdSchema }) id: string,
    @Body({ schema: updateStoreSchema }) dto: UpdateStoreDto,
  ): Promise<StoreView> {
    return this.stores.updateAdmin(id, dto);
  }

  @Post('admin/stores/:id/deactivate')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Desactiva una tienda (idempotente); no se borra.',
  })
  deactivateStore(
    @Param('id', { schema: objectIdSchema }) id: string,
  ): Promise<StoreView> {
    return this.stores.deactivate(id);
  }
}

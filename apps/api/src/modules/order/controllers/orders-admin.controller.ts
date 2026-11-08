import { Controller, Get, Param, Query } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { Roles } from '../../../../../../libs/common/src/security/decorators.js';
import { Role } from '../../../../../../libs/common/src/security/roles.js';
import { objectIdSchema } from '../dto/cart.dto.js';
import {
  type AdminOrdersQuery,
  adminOrdersQuerySchema,
} from '../dto/order-query.dto.js';
import type { Page } from '../policies/pagination.policy.js';
import {
  type AdminOrderSummaryView,
  type OrderView,
  OrdersService,
} from '../services/orders.service.js';

/** Lectura de todos los pedidos para el ADMIN. No hay endpoints que los modifiquen. */
@ApiTags('orders')
@ApiBearerAuth()
@Roles(Role.ADMIN)
@Controller('orders/admin')
export class OrdersAdminController {
  constructor(private readonly orders: OrdersService) {}

  @Get()
  @ApiOperation({ summary: 'Todos los pedidos, con filtros status y buyerId.' })
  list(
    @Query({ schema: adminOrdersQuerySchema }) query: AdminOrdersQuery,
  ): Promise<Page<AdminOrderSummaryView>> {
    return this.orders.listAll(query);
  }

  @Get(':id')
  @ApiOperation({ summary: 'Detalle completo de cualquier pedido.' })
  get(@Param('id', { schema: objectIdSchema }) id: string): Promise<OrderView> {
    return this.orders.getAny(id);
  }
}

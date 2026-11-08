import { Controller, Get, Param, Query } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import {
  CurrentUser,
  Roles,
} from '../../../../../../libs/common/src/security/decorators.js';
import {
  type AuthenticatedUser,
  Role,
} from '../../../../../../libs/common/src/security/roles.js';
import { objectIdSchema } from '../dto/cart.dto.js';
import {
  type ProviderSubOrdersQuery,
  providerSubOrdersQuerySchema,
} from '../dto/order-query.dto.js';
import type { Page } from '../policies/pagination.policy.js';
import {
  OrdersService,
  type ProviderSubOrderView,
} from '../services/orders.service.js';

/**
 * Sub-pedidos pagados de la tienda del PROVEEDOR. La tienda sale del claim
 * `user.storeId`; sin él la lista es vacía y el detalle da 404.
 */
@ApiTags('orders')
@ApiBearerAuth()
@Roles(Role.PROVEEDOR)
@Controller('orders/provider/sub-orders')
export class ProviderOrdersController {
  constructor(private readonly orders: OrdersService) {}

  @Get()
  @ApiOperation({
    summary:
      'Sub-pedidos de mi tienda con el pedido CONFIRMED (sin buyerId ni total).',
  })
  list(
    @CurrentUser() user: AuthenticatedUser,
    @Query({ schema: providerSubOrdersQuerySchema })
    query: ProviderSubOrdersQuery,
  ): Promise<Page<ProviderSubOrderView>> {
    return this.orders.listProviderSubOrders(user.storeId, query);
  }

  @Get(':id')
  @ApiOperation({
    summary: 'Sub-pedido de mi tienda; ajeno o sin pagar: 404.',
  })
  get(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id', { schema: objectIdSchema }) id: string,
  ): Promise<ProviderSubOrderView> {
    return this.orders.getProviderSubOrder(user.storeId, id);
  }
}

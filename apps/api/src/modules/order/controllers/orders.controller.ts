import {
  BadRequestException,
  Controller,
  Get,
  Headers,
  HttpStatus,
  Param,
  Post,
  Query,
  Res,
} from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiHeader,
  ApiOperation,
  ApiTags,
} from '@nestjs/swagger';
import type { Response } from 'express';
import {
  CurrentUser,
  Roles,
} from '../../../../../../libs/common/src/security/decorators.js';
import {
  type AuthenticatedUser,
  Role,
} from '../../../../../../libs/common/src/security/roles.js';
import { objectIdSchema } from '../dto/cart.dto.js';
import { idempotencyKeySchema } from '../dto/checkout.dto.js';
import { type OrdersQuery, ordersQuerySchema } from '../dto/order-query.dto.js';
import type { Page } from '../policies/pagination.policy.js';
import { CheckoutService } from '../services/checkout.service.js';
import {
  type OrderSummaryView,
  type OrderView,
  OrdersService,
} from '../services/orders.service.js';

/** Checkout y pedidos del PRODUCTOR. */
@ApiTags('orders')
@ApiBearerAuth()
@Roles(Role.PRODUCTOR)
@Controller('orders')
export class OrdersController {
  constructor(
    private readonly checkout: CheckoutService,
    private readonly orders: OrdersService,
  ) {}

  @Post('checkout')
  @ApiOperation({
    summary:
      'Crea el pedido PENDING desde el carrito. Repetir la Idempotency-Key devuelve el mismo pedido con 200.',
  })
  @ApiHeader({ name: 'Idempotency-Key', required: true })
  async createOrder(
    @CurrentUser() user: AuthenticatedUser,
    @Headers('idempotency-key') rawKey: unknown,
    @Res({ passthrough: true }) res: Response,
  ): Promise<OrderView> {
    const key = idempotencyKeySchema.safeParse(rawKey);
    if (!key.success) {
      throw new BadRequestException(
        'Idempotency-Key obligatoria: de 8 a 100 caracteres',
      );
    }
    const { order, created } = await this.checkout.checkout(user.id, key.data);
    res.status(created ? HttpStatus.CREATED : HttpStatus.OK);
    return order;
  }

  @Get()
  @ApiOperation({
    summary: 'Pedidos del PRODUCTOR, del más reciente al más antiguo.',
  })
  list(
    @CurrentUser() user: AuthenticatedUser,
    @Query({ schema: ordersQuerySchema }) query: OrdersQuery,
  ): Promise<Page<OrderSummaryView>> {
    return this.orders.listMine(user.id, query);
  }

  @Get(':id')
  @ApiOperation({
    summary: 'Pedido propio con sub-pedidos e ítems; ajeno: 404.',
  })
  get(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id', { schema: objectIdSchema }) id: string,
  ): Promise<OrderView> {
    return this.orders.getMine(user.id, id);
  }
}

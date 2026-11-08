import {
  BadRequestException,
  Controller,
  Headers,
  HttpStatus,
  Post,
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
import { idempotencyKeySchema } from '../dto/checkout.dto.js';
import {
  CheckoutService,
  type OrderView,
} from '../services/checkout.service.js';

/** Checkout y pedidos del PRODUCTOR. */
@ApiTags('orders')
@ApiBearerAuth()
@Roles(Role.PRODUCTOR)
@Controller('orders')
export class OrdersController {
  constructor(private readonly checkout: CheckoutService) {}

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
}

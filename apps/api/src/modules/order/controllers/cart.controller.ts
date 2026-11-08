import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  Put,
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
  setCartItemSchema,
  type SetCartItemDto,
  variantIdParamSchema,
} from '../dto/cart.dto.js';
import {
  CartService,
  type CartLineView,
  type CartView,
} from '../services/cart.service.js';

/** Carrito del PRODUCTOR. */
@ApiTags('orders')
@ApiBearerAuth()
@Roles(Role.PRODUCTOR)
@Controller('orders/cart')
export class CartController {
  constructor(private readonly cart: CartService) {}

  @Get()
  @ApiOperation({
    summary:
      'Carrito con precio vigente, disponibilidad y aptitud actuales del catálogo.',
  })
  get(@CurrentUser() user: AuthenticatedUser): Promise<CartView> {
    return this.cart.get(user.id);
  }

  @Put('items/:variantId')
  @ApiOperation({
    summary: 'Fija la cantidad (valor absoluto) de una variante en el carrito.',
  })
  setItem(
    @CurrentUser() user: AuthenticatedUser,
    @Param('variantId', { schema: variantIdParamSchema }) variantId: string,
    @Body({ schema: setCartItemSchema }) dto: SetCartItemDto,
  ): Promise<CartLineView> {
    return this.cart.setItem(user.id, variantId, dto.cantidad);
  }

  @Delete('items/:variantId')
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({ summary: 'Quita una línea del carrito (idempotente).' })
  removeItem(
    @CurrentUser() user: AuthenticatedUser,
    @Param('variantId', { schema: variantIdParamSchema }) variantId: string,
  ): Promise<void> {
    return this.cart.removeItem(user.id, variantId);
  }

  @Delete()
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({ summary: 'Vacía el carrito.' })
  clear(@CurrentUser() user: AuthenticatedUser): Promise<void> {
    return this.cart.clear(user.id);
  }
}

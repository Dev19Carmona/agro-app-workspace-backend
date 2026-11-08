import {
  BadRequestException,
  Body,
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
import { Throttle } from '@nestjs/throttler';
import type { Response } from 'express';
import {
  CurrentUser,
  Roles,
} from '../../../../../../libs/common/src/security/decorators.js';
import {
  type AuthenticatedUser,
  Role,
} from '../../../../../../libs/common/src/security/roles.js';
import {
  type CreatePaymentDto,
  createPaymentSchema,
  idempotencyKeySchema,
  paymentIdParamSchema,
} from '../dto/create-payment.dto.js';
import {
  type PaymentsQuery,
  paymentsQuerySchema,
} from '../dto/payment-query.dto.js';
import type { Page } from '../policies/pagination.policy.js';
import { PaymentsQueryService } from '../services/payments-query.service.js';
import { PaymentsService } from '../services/payments.service.js';
import { type PaymentView, toPaymentView } from '../services/payment-view.js';

/** Pagos del PRODUCTOR. */
@ApiTags('payments')
@ApiBearerAuth()
@Roles(Role.PRODUCTOR)
@Throttle({ default: { limit: 10, ttl: 60_000 } })
@Controller('payments')
export class PaymentsController {
  constructor(
    private readonly payments: PaymentsService,
    private readonly queries: PaymentsQueryService,
  ) {}

  @Post()
  @ApiOperation({
    summary:
      'Cobra un pedido AWAITING_PAYMENT con la pasarela simulada. El monto sale del pedido. Repetir la Idempotency-Key devuelve el mismo pago con 200.',
  })
  @ApiHeader({ name: 'Idempotency-Key', required: true })
  async create(
    @CurrentUser() user: AuthenticatedUser,
    @Headers('idempotency-key') rawKey: unknown,
    @Body({ schema: createPaymentSchema }) dto: CreatePaymentDto,
    @Res({ passthrough: true }) res: Response,
  ): Promise<PaymentView> {
    const key = idempotencyKeySchema.safeParse(rawKey);
    if (!key.success) {
      throw new BadRequestException(
        'Idempotency-Key obligatoria: de 8 a 100 caracteres',
      );
    }
    const { payment, replay } = await this.payments.create(
      user.id,
      key.data,
      dto,
    );
    res.status(replay ? HttpStatus.OK : HttpStatus.CREATED);
    return toPaymentView(payment);
  }

  @Get()
  @ApiOperation({
    summary: 'Pagos del PRODUCTOR, del más reciente al más antiguo.',
  })
  list(
    @CurrentUser() user: AuthenticatedUser,
    @Query({ schema: paymentsQuerySchema }) query: PaymentsQuery,
  ): Promise<Page<PaymentView>> {
    return this.queries.listMine(user.id, query);
  }

  @Get(':id')
  @ApiOperation({ summary: 'Pago propio; ajeno: 404.' })
  get(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id', { schema: paymentIdParamSchema }) id: string,
  ): Promise<PaymentView> {
    return this.queries.getMine(user.id, id);
  }
}

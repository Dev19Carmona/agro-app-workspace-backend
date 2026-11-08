import { Controller, Get, Param, Query } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';
import { Roles } from '../../../../../../libs/common/src/security/decorators.js';
import { Role } from '../../../../../../libs/common/src/security/roles.js';
import { paymentIdParamSchema } from '../dto/create-payment.dto.js';
import {
  type AdminPaymentsQuery,
  adminPaymentsQuerySchema,
} from '../dto/payment-query.dto.js';
import type { Page } from '../policies/pagination.policy.js';
import {
  type AdminPaymentDetailView,
  type AdminPaymentView,
  PaymentsQueryService,
} from '../services/payments-query.service.js';

/** Consulta de pagos del ADMIN: solo lectura, ningún endpoint modifica pagos. */
@ApiTags('payments')
@ApiBearerAuth()
@Roles(Role.ADMIN)
@Throttle({ default: { limit: 10, ttl: 60_000 } })
@Controller('payments/admin')
export class PaymentsAdminController {
  constructor(private readonly queries: PaymentsQueryService) {}

  @Get()
  @ApiOperation({
    summary:
      'Todos los pagos, del más reciente al más antiguo; filtros status, buyerId y orderId.',
  })
  list(
    @Query({ schema: adminPaymentsQuerySchema }) query: AdminPaymentsQuery,
  ): Promise<Page<AdminPaymentView>> {
    return this.queries.listAdmin(query);
  }

  @Get(':id')
  @ApiOperation({ summary: 'Detalle de un pago con sus intentos.' })
  get(
    @Param('id', { schema: paymentIdParamSchema }) id: string,
  ): Promise<AdminPaymentDetailView> {
    return this.queries.getAdmin(id);
  }
}

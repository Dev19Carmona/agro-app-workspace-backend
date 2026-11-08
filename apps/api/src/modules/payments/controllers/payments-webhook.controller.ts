import {
  BadRequestException,
  Controller,
  Headers,
  HttpCode,
  HttpStatus,
  Post,
  type RawBodyRequest,
  Req,
} from '@nestjs/common';
import { ApiHeader, ApiOperation, ApiTags } from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';
import type { Request } from 'express';
import { Public } from '../../../../../../libs/common/src/security/decorators.js';
import { webhookSchema } from '../dto/webhook.dto.js';
import { WebhookService } from '../services/webhook.service.js';

/** Webhook de la pasarela: sin JWT, se autentica solo por firma HMAC. */
@ApiTags('payments')
@Public()
@Throttle({ default: { limit: 10, ttl: 60_000 } })
@Controller('payments/webhook')
export class PaymentsWebhookController {
  constructor(private readonly webhook: WebhookService) {}

  @Post()
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary:
      'Resuelve un pago PROCESSING. Firma HMAC-SHA256 de `${X-Timestamp}.${cuerpo crudo}` en X-Signature.',
  })
  @ApiHeader({ name: 'X-Signature', required: true })
  @ApiHeader({ name: 'X-Timestamp', required: true })
  async receive(
    @Req() req: RawBodyRequest<Request>,
    @Headers('x-signature') signature: string | undefined,
    @Headers('x-timestamp') timestamp: string | undefined,
  ): Promise<{ status: 'OK' }> {
    // Primero la firma: un cuerpo inválido no revela nada a quien no firma.
    this.webhook.verifySignature(req.rawBody, timestamp, signature);

    const body = webhookSchema.safeParse(req.body);
    if (!body.success) {
      throw new BadRequestException('Cuerpo del webhook inválido');
    }
    await this.webhook.resolve(body.data);
    return { status: 'OK' };
  }
}

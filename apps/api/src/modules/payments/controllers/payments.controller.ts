import { ApiTags } from '@nestjs/swagger';
import { Controller, Get } from '@nestjs/common';
import { PaymentsService } from '../services/payments.service.js';

@ApiTags('payments')
@Controller('payments')
export class PaymentsController {
  constructor(private readonly paymentsService: PaymentsService) {}

  @Get()
  getHello(): string {
    return this.paymentsService.getHello();
  }
}

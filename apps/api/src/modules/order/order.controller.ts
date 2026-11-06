import { ApiTags } from '@nestjs/swagger';
import { Controller, Get } from '@nestjs/common';
import { OrderService } from './order.service.js';

@ApiTags('order')
@Controller('orders')
export class OrderController {
  constructor(private readonly orderService: OrderService) {}

  @Get()
  getHello(): string {
    return this.orderService.getHello();
  }
}

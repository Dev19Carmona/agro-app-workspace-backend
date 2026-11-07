import { ApiTags } from '@nestjs/swagger';
import { Controller, Get } from '@nestjs/common';
import { OrderService } from '../services/order.service.js';

@ApiTags('orders')
@Controller('orders')
export class OrderController {
  constructor(private readonly orderService: OrderService) {}

  @Get()
  getHello(): string {
    return this.orderService.getHello();
  }
}

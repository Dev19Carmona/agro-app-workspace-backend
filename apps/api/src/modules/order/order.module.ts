import { Module } from '@nestjs/common';
import { OrderController } from './controllers/order.controller.js';
import { OrderService } from './services/order.service.js';

@Module({
  imports: [],
  controllers: [OrderController],
  providers: [OrderService],
})
export class OrderModule {}

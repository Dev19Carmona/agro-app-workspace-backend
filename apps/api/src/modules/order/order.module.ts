import { Module } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';
import { OrderController } from './controllers/order.controller.js';
import { CartItem, CartItemSchema } from './schemas/cart-item.schema.js';
import { Cart, CartSchema } from './schemas/cart.schema.js';
import { OrderItem, OrderItemSchema } from './schemas/order-item.schema.js';
import { Order, OrderSchema } from './schemas/order.schema.js';
import {
  OutboxEvent,
  OutboxEventSchema,
} from './schemas/outbox-event.schema.js';
import {
  OrderProcessedEvent,
  OrderProcessedEventSchema,
} from './schemas/processed-event.schema.js';
import { SubOrder, SubOrderSchema } from './schemas/sub-order.schema.js';
import { OrderService } from './services/order.service.js';

@Module({
  imports: [
    MongooseModule.forFeature([
      { name: Cart.name, schema: CartSchema },
      { name: CartItem.name, schema: CartItemSchema },
      { name: Order.name, schema: OrderSchema },
      { name: SubOrder.name, schema: SubOrderSchema },
      { name: OrderItem.name, schema: OrderItemSchema },
      { name: OutboxEvent.name, schema: OutboxEventSchema },
      { name: OrderProcessedEvent.name, schema: OrderProcessedEventSchema },
    ]),
  ],
  controllers: [OrderController],
  providers: [OrderService],
})
export class OrderModule {}

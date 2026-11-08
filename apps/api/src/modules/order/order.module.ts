import { Module } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';
import { CatalogModule } from '../catalog/index.js';
import { CartController } from './controllers/cart.controller.js';
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
import { CartService } from './services/cart.service.js';
import { OrderService } from './services/order.service.js';
import { OutboxService } from './services/outbox.service.js';

@Module({
  imports: [
    CatalogModule,
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
  controllers: [OrderController, CartController],
  providers: [OrderService, CartService, OutboxService],
})
export class OrderModule {}

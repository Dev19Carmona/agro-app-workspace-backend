import { Module } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';
import { ScheduleModule } from '@nestjs/schedule';
import { CatalogModule } from '../catalog/index.js';
import { CartController } from './controllers/cart.controller.js';
import { OrdersController } from './controllers/orders.controller.js';
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
import { CheckoutService } from './services/checkout.service.js';
import { OrderSagaService } from './services/order-saga.service.js';
import { OutboxPublisherService } from './services/outbox-publisher.service.js';
import { OutboxService } from './services/outbox.service.js';

@Module({
  imports: [
    CatalogModule,
    ScheduleModule.forRoot(),
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
  controllers: [OrdersController, CartController],
  providers: [
    CartService,
    CheckoutService,
    OutboxService,
    OutboxPublisherService,
    OrderSagaService,
  ],
})
export class OrderModule {}

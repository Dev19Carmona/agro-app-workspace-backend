import { Test, TestingModule } from '@nestjs/testing';
import { OrderController } from '../controllers/order.controller.js';
import { OrderService } from '../services/order.service.js';

describe('OrderController', () => {
  let orderController: OrderController;

  beforeEach(async () => {
    const app: TestingModule = await Test.createTestingModule({
      controllers: [OrderController],
      providers: [OrderService],
    }).compile();

    orderController = app.get<OrderController>(OrderController);
  });

  describe('root', () => {
    it('should return "Hello World!"', () => {
      expect(orderController.getHello()).toBe('Hello World!');
    });
  });
});

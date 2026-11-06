import { Test, TestingModule } from '@nestjs/testing';
import { OrderController } from './order.controller.js';
import { OrderService } from './order.service.js';

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

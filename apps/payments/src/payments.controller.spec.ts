import { Test, TestingModule } from '@nestjs/testing';
import { PaymentsController } from './payments.controller.js';
import { PaymentsService } from './payments.service.js';

describe('PaymentsController', () => {
  let paymentsController: PaymentsController;

  beforeEach(async () => {
    const app: TestingModule = await Test.createTestingModule({
      controllers: [PaymentsController],
      providers: [PaymentsService],
    }).compile();

    paymentsController = app.get<PaymentsController>(PaymentsController);
  });

  describe('root', () => {
    it('should return "Hello World!"', () => {
      expect(paymentsController.getHello()).toBe('Hello World!');
    });
  });
});

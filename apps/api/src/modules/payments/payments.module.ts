import { Module } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';
import { PaymentsController } from './controllers/payments.controller.js';
import {
  PaymentAttempt,
  PaymentAttemptSchema,
} from './schemas/payment-attempt.schema.js';
import { Payment, PaymentSchema } from './schemas/payment.schema.js';
import {
  PaymentProcessedEvent,
  PaymentProcessedEventSchema,
} from './schemas/processed-event.schema.js';
import { PaymentsService } from './services/payments.service.js';

@Module({
  imports: [
    MongooseModule.forFeature([
      { name: Payment.name, schema: PaymentSchema },
      { name: PaymentAttempt.name, schema: PaymentAttemptSchema },
      {
        name: PaymentProcessedEvent.name,
        schema: PaymentProcessedEventSchema,
      },
    ]),
  ],
  controllers: [PaymentsController],
  providers: [PaymentsService],
})
export class PaymentsModule {}

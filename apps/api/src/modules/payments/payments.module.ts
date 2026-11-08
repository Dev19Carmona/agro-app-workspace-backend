import { Module } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';
import { OrderModule } from '../order/index.js';
import { PaymentsAdminController } from './controllers/payments-admin.controller.js';
import { PaymentsWebhookController } from './controllers/payments-webhook.controller.js';
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
import { PaymentEventsService } from './services/payment-events.service.js';
import { PAYMENT_GATEWAY } from './services/payment-gateway.js';
import { PaymentsQueryService } from './services/payments-query.service.js';
import { PaymentsService } from './services/payments.service.js';
import { SimulatedGatewayService } from './services/simulated-gateway.service.js';
import { WebhookService } from './services/webhook.service.js';

@Module({
  imports: [
    OrderModule,
    MongooseModule.forFeature([
      { name: Payment.name, schema: PaymentSchema },
      { name: PaymentAttempt.name, schema: PaymentAttemptSchema },
      {
        name: PaymentProcessedEvent.name,
        schema: PaymentProcessedEventSchema,
      },
    ]),
  ],
  // `admin` va antes de `:id` para que `PaymentsController` no lo capture.
  controllers: [
    PaymentsAdminController,
    PaymentsController,
    PaymentsWebhookController,
  ],
  providers: [
    PaymentsService,
    PaymentsQueryService,
    WebhookService,
    PaymentEventsService,
    { provide: PAYMENT_GATEWAY, useClass: SimulatedGatewayService },
  ],
})
export class PaymentsModule {}

import { Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { MongooseModule } from '@nestjs/mongoose';
import { ScheduleModule } from '@nestjs/schedule';
import type { ApiEnv } from '../../../../../libs/common/src/config/env.schema.js';
import { RabbitMqConnection } from '../../../../../libs/common/src/messaging/rabbitmq-connection.js';
import {
  NotificationOutboxEvent,
  NotificationOutboxEventSchema,
} from './schemas/notification-outbox.schema.js';
import { BridgeEnvelopeListenerService } from './services/bridge-envelope-listener.service.js';
import { BridgeListenerService } from './services/bridge-listener.service.js';
import { BridgePublisherService } from './services/bridge-publisher.service.js';
import { EVENT_PUBLISHER } from './services/event-publisher.js';
import { RabbitMqEventPublisher } from './services/rabbitmq-event-publisher.service.js';

/** Puente entre los eventos en memoria del monolito y RabbitMQ (hacia `notifications`). */
@Module({
  imports: [
    ScheduleModule.forRoot(),
    MongooseModule.forFeature([
      {
        name: NotificationOutboxEvent.name,
        schema: NotificationOutboxEventSchema,
      },
    ]),
  ],
  providers: [
    BridgeListenerService,
    BridgeEnvelopeListenerService,
    BridgePublisherService,
    {
      provide: RabbitMqConnection,
      inject: [ConfigService],
      useFactory: (config: ConfigService<ApiEnv, true>) =>
        new RabbitMqConnection(config.get('RABBITMQ_URI', { infer: true })),
    },
    { provide: EVENT_PUBLISHER, useClass: RabbitMqEventPublisher },
  ],
})
export class NotificationBridgeModule {}

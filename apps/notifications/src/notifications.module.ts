import { Module } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { MongooseModule } from '@nestjs/mongoose';
import type { Env } from '../../../libs/common/src/config/env.schema.js';
import { validateEnv } from '../../../libs/common/src/config/env.schema.js';
import { HealthModule } from '../../../libs/common/src/health/health.module.js';
import { RabbitMqConnection } from '../../../libs/common/src/messaging/rabbitmq-connection.js';
import { EventsConsumer } from './consumers/events.consumer.js';
import {
  Notification,
  NotificationSchema,
} from './schemas/notification.schema.js';
import { NotificationsService } from './services/notifications.service.js';

@Module({
  imports: [
    ConfigModule.forRoot({ isGlobal: true, validate: validateEnv }),
    MongooseModule.forRootAsync({
      inject: [ConfigService],
      useFactory: (config: ConfigService<Env, true>) => ({
        uri: config.get('MONGODB_URI', { infer: true }),
        dbName: 'mini-croper-notifications',
      }),
    }),
    MongooseModule.forFeature([
      { name: Notification.name, schema: NotificationSchema },
    ]),
    HealthModule,
  ],
  providers: [
    NotificationsService,
    {
      provide: RabbitMqConnection,
      inject: [ConfigService],
      useFactory: (config: ConfigService<Env, true>) =>
        new RabbitMqConnection(config.get('RABBITMQ_URI', { infer: true })),
    },
    EventsConsumer,
  ],
})
export class NotificationsModule {}

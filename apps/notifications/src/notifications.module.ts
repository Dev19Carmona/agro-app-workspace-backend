import { Module, StandardSchemaValidationPipe } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { APP_PIPE } from '@nestjs/core';
import { MongooseModule } from '@nestjs/mongoose';
import type { Env } from '../../../libs/common/src/config/env.schema.js';
import { validateEnv } from '../../../libs/common/src/config/env.schema.js';
import { HealthModule } from '../../../libs/common/src/health/health.module.js';
import { RabbitMqConnection } from '../../../libs/common/src/messaging/rabbitmq-connection.js';
import { EventsConsumer } from './consumers/events.consumer.js';
import { InternalNotificationsController } from './controllers/internal-notifications.controller.js';
import {
  Notification,
  NotificationSchema,
} from './schemas/notification.schema.js';
import { NotificationsQueryService } from './services/notifications-query.service.js';
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
  controllers: [InternalNotificationsController],
  providers: [
    // Valida @Query({ schema }), @Body({ schema }) y @Param(nombre, { schema }).
    { provide: APP_PIPE, useClass: StandardSchemaValidationPipe },
    NotificationsService,
    NotificationsQueryService,
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

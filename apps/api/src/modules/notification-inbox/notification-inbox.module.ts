import { Module } from '@nestjs/common';
import { NotificationsController } from './controllers/notifications.controller.js';
import { HttpNotificationsReader } from './services/http-notifications-reader.service.js';
import { NotificationInboxService } from './services/notification-inbox.service.js';
import { NOTIFICATIONS_READER } from './services/notifications-reader.js';

/**
 * Camino de lectura de los avisos (HTTP hacia `notifications`). Es independiente de
 * `notification-bridge`, que es el camino de escritura (eventos por RabbitMQ).
 */
@Module({
  controllers: [NotificationsController],
  providers: [
    NotificationInboxService,
    { provide: NOTIFICATIONS_READER, useClass: HttpNotificationsReader },
  ],
})
export class NotificationInboxModule {}

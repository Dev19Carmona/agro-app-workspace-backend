import { Inject, Injectable } from '@nestjs/common';
import type { AuthenticatedUser } from '../../../../../../libs/common/src/security/roles.js';
import type { NotificationsQuery } from '../dto/notifications.dto.js';
import { actorFor } from '../policies/actor.policy.js';
import {
  NOTIFICATIONS_READER,
  type NotificationPage,
  type NotificationsReader,
  type NotificationView,
} from './notifications-reader.js';

/** Arma el actor desde el usuario autenticado y delega en el lector. */
@Injectable()
export class NotificationInboxService {
  constructor(
    @Inject(NOTIFICATIONS_READER) private readonly reader: NotificationsReader,
  ) {}

  list(
    user: AuthenticatedUser,
    { limit, cursor }: NotificationsQuery,
  ): Promise<NotificationPage> {
    return this.reader.list(actorFor(user), { limit, cursor });
  }

  unreadCount(user: AuthenticatedUser): Promise<{ count: number }> {
    return this.reader.unreadCount(actorFor(user));
  }

  markRead(user: AuthenticatedUser, id: string): Promise<NotificationView> {
    return this.reader.markRead(actorFor(user), id);
  }

  markAllRead(user: AuthenticatedUser): Promise<{ updated: number }> {
    return this.reader.markAllRead(actorFor(user));
  }
}

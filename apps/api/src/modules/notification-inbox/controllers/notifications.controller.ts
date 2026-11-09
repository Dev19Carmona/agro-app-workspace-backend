import {
  Controller,
  Get,
  HttpCode,
  Param,
  Patch,
  Post,
  Query,
} from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';
import {
  CurrentUser,
  Roles,
} from '../../../../../../libs/common/src/security/decorators.js';
import {
  type AuthenticatedUser,
  Role,
} from '../../../../../../libs/common/src/security/roles.js';
import {
  type NotificationsQuery,
  notificationsQuerySchema,
  objectIdSchema,
} from '../dto/notifications.dto.js';
import { NotificationInboxService } from '../services/notification-inbox.service.js';
import type {
  NotificationPage,
  NotificationView,
} from '../services/notifications-reader.js';

/** Lecturas: el frontend sondea cada 30-60 s. */
const READ_LIMIT = { default: { limit: 60, ttl: 60_000 } };
const WRITE_LIMIT = { default: { limit: 30, ttl: 60_000 } };

/**
 * Bandeja de avisos del PRODUCTOR y del PROVEEDOR. El actor sale siempre del token:
 * ninguna ruta acepta `userId` ni `storeId`. Las rutas fijas van antes que `:id/read`.
 */
@ApiTags('notifications')
@ApiBearerAuth()
@Roles(Role.PRODUCTOR, Role.PROVEEDOR)
@Controller('notifications')
export class NotificationsController {
  constructor(private readonly inbox: NotificationInboxService) {}

  @Get()
  @Throttle(READ_LIMIT)
  @ApiOperation({
    summary:
      'Avisos del actor, del más nuevo al más viejo, paginados por cursor (limit 1-50).',
  })
  list(
    @CurrentUser() user: AuthenticatedUser,
    @Query({ schema: notificationsQuerySchema }) query: NotificationsQuery,
  ): Promise<NotificationPage> {
    return this.inbox.list(user, query);
  }

  @Get('unread-count')
  @Throttle(READ_LIMIT)
  @ApiOperation({ summary: 'Cantidad de avisos sin leer.' })
  unreadCount(
    @CurrentUser() user: AuthenticatedUser,
  ): Promise<{ count: number }> {
    return this.inbox.unreadCount(user);
  }

  @Post('read-all')
  @HttpCode(200)
  @Throttle(WRITE_LIMIT)
  @ApiOperation({ summary: 'Marca como leídos todos los avisos visibles.' })
  readAll(
    @CurrentUser() user: AuthenticatedUser,
  ): Promise<{ updated: number }> {
    return this.inbox.markAllRead(user);
  }

  @Patch(':id/read')
  @Throttle(WRITE_LIMIT)
  @ApiOperation({
    summary:
      'Marca un aviso como leído (idempotente). Ajeno o inexistente: 404.',
  })
  markRead(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id', { schema: objectIdSchema }) id: string,
  ): Promise<NotificationView> {
    return this.inbox.markRead(user, id);
  }
}

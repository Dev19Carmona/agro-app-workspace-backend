import {
  Body,
  Controller,
  Get,
  HttpCode,
  Param,
  Patch,
  Post,
  Query,
  UseGuards,
} from '@nestjs/common';
import { ApiHeader, ApiOperation, ApiTags } from '@nestjs/swagger';
import {
  type ActorBody,
  type ActorQuery,
  actorBodySchema,
  actorQuerySchema,
  type ListQuery,
  listQuerySchema,
  objectIdSchema,
} from '../dto/internal-notifications.dto.js';
import { ServiceTokenGuard } from '../guards/service-token.guard.js';
import {
  type NotificationPage,
  NotificationsQueryService,
  type NotificationView,
} from '../services/notifications-query.service.js';

/**
 * API interna: solo la llama `api`, con `X-Service-Token`. No es pública y el puerto 3005
 * no debe alcanzarse desde fuera de la red interna. El actor lo arma `api` desde el JWT.
 * Las rutas fijas van antes que `:id/read`.
 */
@ApiTags('internal')
@ApiHeader({ name: 'X-Service-Token', required: true })
@UseGuards(ServiceTokenGuard)
@Controller('internal/notifications')
export class InternalNotificationsController {
  constructor(private readonly notifications: NotificationsQueryService) {}

  @Get()
  @ApiOperation({ summary: 'Avisos del actor, del más nuevo al más viejo.' })
  list(
    @Query({ schema: listQuerySchema }) { limit, cursor, ...actor }: ListQuery,
  ): Promise<NotificationPage> {
    return this.notifications.list(actor, { limit, cursor });
  }

  @Get('unread-count')
  @ApiOperation({ summary: 'Cantidad de avisos sin leer del actor.' })
  unreadCount(
    @Query({ schema: actorQuerySchema }) actor: ActorQuery,
  ): Promise<{ count: number }> {
    return this.notifications.unreadCount(actor);
  }

  @Post('read-all')
  @HttpCode(200)
  @ApiOperation({ summary: 'Marca como leídos todos los avisos del actor.' })
  readAll(
    @Body({ schema: actorBodySchema }) actor: ActorBody,
  ): Promise<{ updated: number }> {
    return this.notifications.markAllRead(actor);
  }

  @Patch(':id/read')
  @ApiOperation({ summary: 'Marca un aviso como leído (idempotente).' })
  markRead(
    @Param('id', { schema: objectIdSchema }) id: string,
    @Body({ schema: actorBodySchema }) actor: ActorBody,
  ): Promise<NotificationView> {
    return this.notifications.markRead(actor, id);
  }
}

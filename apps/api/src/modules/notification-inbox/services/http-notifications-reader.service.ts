import {
  Injectable,
  Logger,
  NotFoundException,
  ServiceUnavailableException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { z } from 'zod';
import type { ApiEnv } from '../../../../../../libs/common/src/config/env.schema.js';
import type {
  InboxActor,
  ListParams,
  NotificationPage,
  NotificationsReader,
  NotificationView,
} from './notifications-reader.js';

/** Tiempo límite de cada llamada a `notifications`. */
export const NOTIFICATIONS_TIMEOUT_MS = 3000;

// `z.object` descarta los campos de más: lo que `notifications` agregue por descuido
// nunca llega al cliente.
const viewSchema = z.object({
  id: z.string(),
  plantilla: z.string(),
  destinatarioTipo: z.enum(['USER', 'STORE']),
  titulo: z.string(),
  mensaje: z.string(),
  orderId: z.string().nullable(),
  sentAt: z.string(),
  readAt: z.string().nullable(),
});
const pageSchema = z.object({
  data: z.array(viewSchema),
  nextCursor: z.string().nullable(),
});
const countSchema = z.object({ count: z.number().int() });
const updatedSchema = z.object({ updated: z.number().int() });

type RequestOptions = {
  query?: Record<string, string | number | undefined>;
  body?: unknown;
};

/** Cliente `fetch` de la API interna de `notifications` (`/internal/notifications`). */
@Injectable()
export class HttpNotificationsReader implements NotificationsReader {
  private readonly logger = new Logger(HttpNotificationsReader.name);
  private readonly baseUrl: string;
  private readonly token: string;

  constructor(config: ConfigService<ApiEnv, true>) {
    this.baseUrl = config
      .get('NOTIFICATIONS_INTERNAL_URL', { infer: true })
      .replace(/\/+$/, '');
    this.token = config.get('INTERNAL_SERVICE_TOKEN', { infer: true });
  }

  list(
    actor: InboxActor,
    { limit, cursor }: ListParams,
  ): Promise<NotificationPage> {
    return this.request('GET', '', pageSchema, {
      query: { ...actor, limit, cursor },
    });
  }

  unreadCount(actor: InboxActor): Promise<{ count: number }> {
    return this.request('GET', '/unread-count', countSchema, { query: actor });
  }

  markRead(actor: InboxActor, id: string): Promise<NotificationView> {
    return this.request('PATCH', `/${id}/read`, viewSchema, { body: actor });
  }

  markAllRead(actor: InboxActor): Promise<{ updated: number }> {
    return this.request('POST', '/read-all', updatedSchema, { body: actor });
  }

  private async request<T>(
    method: 'GET' | 'POST' | 'PATCH',
    path: string,
    schema: z.ZodType<T>,
    { query, body }: RequestOptions = {},
  ): Promise<T> {
    const params = new URLSearchParams();
    for (const [key, value] of Object.entries(query ?? {})) {
      if (value !== undefined) params.set(key, String(value));
    }
    const qs = params.size > 0 ? `?${params}` : '';
    let response: Response;
    try {
      response = await fetch(
        `${this.baseUrl}/internal/notifications${path}${qs}`,
        {
          method,
          headers: {
            'X-Service-Token': this.token,
            ...(body !== undefined && { 'Content-Type': 'application/json' }),
          },
          ...(body !== undefined && { body: JSON.stringify(body) }),
          signal: AbortSignal.timeout(NOTIFICATIONS_TIMEOUT_MS),
        },
      );
    } catch (error) {
      const timeout = error instanceof Error && error.name === 'TimeoutError';
      this.logger.warn(
        timeout
          ? 'notifications no respondió a tiempo (timeout)'
          : 'notifications no está disponible (conexión fallida)',
      );
      throw this.unavailable();
    }

    if (response.status === 404)
      throw new NotFoundException('Aviso no encontrado');
    if (response.status === 401) {
      this.logger.error('token de servicio rechazado por notifications');
      throw this.unavailable();
    }
    if (response.status >= 500) {
      this.logger.warn(`notifications respondió ${response.status}`);
      throw this.unavailable();
    }
    if (!response.ok) {
      this.logger.error(`notifications respondió ${response.status}`);
      throw this.unavailable();
    }

    let parsed: z.ZodSafeParseResult<T>;
    try {
      parsed = schema.safeParse(await response.json());
    } catch {
      parsed = { success: false } as z.ZodSafeParseResult<T>;
    }
    if (!parsed.success) {
      this.logger.error(
        `notifications respondió ${response.status} con un cuerpo inesperado`,
      );
      throw this.unavailable();
    }
    return parsed.data;
  }

  private unavailable(): ServiceUnavailableException {
    return new ServiceUnavailableException(
      'Servicio de notificaciones no disponible',
    );
  }
}

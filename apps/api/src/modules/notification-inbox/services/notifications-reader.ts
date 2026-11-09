/** Quién consulta: lo arma `api` desde el JWT, nunca el cliente. */
export type InboxActor = { userId: string; storeId?: string };

/** Lo único que sale hacia el frontend. */
export type NotificationView = {
  id: string;
  plantilla: string;
  destinatarioTipo: 'USER' | 'STORE';
  titulo: string;
  mensaje: string;
  /** Solo en avisos de pagos y pedidos. */
  orderId: string | null;
  sentAt: string;
  readAt: string | null;
};

export type NotificationPage = {
  data: NotificationView[];
  nextCursor: string | null;
};

export type ListParams = { limit: number; cursor?: string };

/**
 * Fuente de los avisos. Hoy es el servicio `notifications` por HTTP; los specs usan un
 * lector simulado. Todos los métodos reciben el actor como primer argumento.
 */
export interface NotificationsReader {
  list(actor: InboxActor, params: ListParams): Promise<NotificationPage>;
  unreadCount(actor: InboxActor): Promise<{ count: number }>;
  markRead(actor: InboxActor, id: string): Promise<NotificationView>;
  markAllRead(actor: InboxActor): Promise<{ updated: number }>;
}

export const NOTIFICATIONS_READER = Symbol('NOTIFICATIONS_READER');

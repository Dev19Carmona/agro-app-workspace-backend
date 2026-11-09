import type { WireEvent } from '../../../../libs/common/src/messaging/domain-event.schema.js';
import type { NotificationDraft } from './notification-templates.js';
import { InvalidEventPayloadError, requireObjectId } from './payload.js';

const TEXTOS: Readonly<Record<string, (orderId: string) => string>> = {
  STOCK_REJECTED: (id) =>
    `Tu pedido ${id} se canceló porque algún producto ya no tiene existencias suficientes.`,
  EXPIRED: (id) => `Tu pedido ${id} se canceló porque venció el plazo de pago.`,
  STOCK_TIMEOUT: (id) =>
    `Tu pedido ${id} se canceló porque no pudimos reservar las existencias a tiempo.`,
  LATE_RESERVATION: (id) =>
    `Tu pedido ${id} se canceló. Si hiciste algún pago, escríbenos para revisarlo.`,
};

/** `order.cancelled`: avisa solo al comprador, con un texto por motivo (el código no se muestra). */
export function orderCancelledTemplate(event: WireEvent): NotificationDraft[] {
  const destinatarioId = requireObjectId(event, 'buyerId');
  const orderId = requireObjectId(event, 'orderId');
  const { motivo } = event.payload;
  const texto =
    typeof motivo === 'string' && Object.hasOwn(TEXTOS, motivo)
      ? TEXTOS[motivo]
      : undefined;
  if (!texto) {
    throw new InvalidEventPayloadError(event.type, 'motivo');
  }
  return [
    {
      destinatarioTipo: 'USER',
      destinatarioId,
      plantilla: 'ORDER_CANCELLED',
      titulo: 'Pedido cancelado',
      mensaje: texto(orderId),
    },
  ];
}

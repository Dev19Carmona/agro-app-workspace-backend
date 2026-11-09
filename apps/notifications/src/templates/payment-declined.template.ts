import type { WireEvent } from '../../../../libs/common/src/messaging/domain-event.schema.js';
import type { NotificationDraft } from './notification-templates.js';
import { requireObjectId } from './payload.js';

/** `payment.declined`: avisa al comprador. Nunca muestra el motivo técnico de la pasarela. */
export function paymentDeclinedTemplate(event: WireEvent): NotificationDraft[] {
  const destinatarioId = requireObjectId(event, 'buyerId');
  const orderId = requireObjectId(event, 'orderId');
  return [
    {
      destinatarioTipo: 'USER',
      destinatarioId,
      plantilla: 'PAYMENT_DECLINED',
      titulo: 'Pago rechazado',
      mensaje: `No pudimos procesar tu pago del pedido ${orderId}. Puedes intentarlo de nuevo mientras el pedido siga vigente.`,
    },
  ];
}

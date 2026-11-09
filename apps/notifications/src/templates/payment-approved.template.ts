import type { WireEvent } from '../../../../libs/common/src/messaging/domain-event.schema.js';
import type { NotificationDraft } from './notification-templates.js';
import { formatCop, requireMonto, requireObjectId } from './payload.js';

/** `payment.approved`: avisa al comprador que recibimos su pago. */
export function paymentApprovedTemplate(event: WireEvent): NotificationDraft[] {
  const destinatarioId = requireObjectId(event, 'buyerId');
  const orderId = requireObjectId(event, 'orderId');
  const monto = requireMonto(event, 'monto');
  return [
    {
      destinatarioTipo: 'USER',
      destinatarioId,
      plantilla: 'PAYMENT_APPROVED',
      titulo: 'Pago recibido',
      mensaje: `Recibimos tu pago de ${formatCop(monto)} del pedido ${orderId}.`,
    },
  ];
}

import type { WireEvent } from '../../../../libs/common/src/messaging/domain-event.schema.js';
import type { NotificationDraft } from './notification-templates.js';
import {
  formatCop,
  requireMonto,
  requireObjectId,
  requireObjectIdList,
} from './payload.js';

/** `order.confirmed`: un aviso al comprador y uno por cada tienda del pedido (1 + N). */
export function orderConfirmedTemplate(event: WireEvent): NotificationDraft[] {
  const buyerId = requireObjectId(event, 'buyerId');
  const orderId = requireObjectId(event, 'orderId');
  const total = requireMonto(event, 'total');
  const storeIds = requireObjectIdList(event, 'storeIds');
  return [
    {
      destinatarioTipo: 'USER',
      destinatarioId: buyerId,
      plantilla: 'ORDER_CONFIRMED_BUYER',
      titulo: 'Pedido confirmado',
      mensaje: `Tu pedido ${orderId} por ${formatCop(total)} quedó confirmado.`,
    },
    ...storeIds.map((storeId): NotificationDraft => ({
      destinatarioTipo: 'STORE',
      destinatarioId: storeId,
      plantilla: 'ORDER_CONFIRMED_STORE',
      titulo: 'Nuevo pedido',
      mensaje: `Tu tienda tiene un pedido confirmado: ${orderId}.`,
    })),
  ];
}

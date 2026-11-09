import type { WireEvent } from '../../../../libs/common/src/messaging/domain-event.schema.js';
import type { NotificationDraft } from './notification-templates.js';
import { requireObjectId } from './payload.js';

/** Largo máximo del motivo que se muestra (texto libre escrito por el ADMIN). */
export const MAX_REASON_LENGTH = 200;

/** `provider.rejected`: avisa al solicitante, con el motivo si existe. Sin email. */
export function providerRejectedTemplate(
  event: WireEvent,
): NotificationDraft[] {
  const destinatarioId = requireObjectId(event, 'userId');
  const { reason } = event.payload;
  const motivo =
    typeof reason === 'string' ? reason.trim().slice(0, MAX_REASON_LENGTH) : '';
  return [
    {
      destinatarioTipo: 'USER',
      destinatarioId,
      plantilla: 'PROVIDER_REJECTED',
      titulo: 'Solicitud rechazada',
      mensaje: motivo
        ? `Tu solicitud como proveedor fue rechazada. Motivo: ${motivo}.`
        : 'Tu solicitud como proveedor fue rechazada.',
    },
  ];
}

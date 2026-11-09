import type { WireEvent } from '../../../../libs/common/src/messaging/domain-event.schema.js';
import type { NotificationDraft } from './notification-templates.js';
import { requireObjectId } from './payload.js';

/** Función pura: `provider.approved` avisa al usuario aprobado. Sin email ni datos personales. */
export function providerApprovedTemplate(
  event: WireEvent,
): NotificationDraft[] {
  return [
    {
      destinatarioTipo: 'USER',
      destinatarioId: requireObjectId(event, 'userId'),
      plantilla: 'PROVIDER_APPROVED',
      titulo: 'Solicitud aprobada',
      mensaje:
        'Tu solicitud como proveedor fue aprobada. Ya puedes iniciar sesión y crear tu tienda.',
    },
  ];
}

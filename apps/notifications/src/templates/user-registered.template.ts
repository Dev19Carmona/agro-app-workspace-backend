import type { WireEvent } from '../../../../libs/common/src/messaging/domain-event.schema.js';
import type { NotificationDraft } from './notification-templates.js';
import { InvalidEventPayloadError, requireObjectId } from './payload.js';

/** `user.registered`: bienvenida al productor o acuse al proveedor (queda pendiente de aprobación). */
export function userRegisteredTemplate(event: WireEvent): NotificationDraft[] {
  const destinatarioId = requireObjectId(event, 'userId');
  const { rol } = event.payload;
  if (rol === 'PRODUCTOR') {
    return [
      {
        destinatarioTipo: 'USER',
        destinatarioId,
        plantilla: 'USER_REGISTERED',
        titulo: 'Bienvenido a Mini-Croper',
        mensaje:
          'Tu cuenta fue creada. Ya puedes explorar el catálogo y hacer pedidos.',
      },
    ];
  }
  if (rol === 'PROVEEDOR') {
    return [
      {
        destinatarioTipo: 'USER',
        destinatarioId,
        plantilla: 'USER_REGISTERED',
        titulo: 'Solicitud recibida',
        mensaje:
          'Recibimos tu solicitud como proveedor. Te avisaremos cuando un administrador la revise.',
      },
    ];
  }
  throw new InvalidEventPayloadError(event.type, 'rol');
}

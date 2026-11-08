import type { WireEvent } from '../../../../libs/common/src/messaging/domain-event.schema.js';
import type { NotificationDraft } from './notification-templates.js';

const OBJECT_ID = /^[0-9a-f]{24}$/i;

/** Payload mal formado: reintentar no lo arregla, pero el consumidor lo trata como fallo. */
export class InvalidEventPayloadError extends Error {
  constructor(type: string, campo: string) {
    super(`Payload inválido en ${type}: ${campo}`);
    this.name = 'InvalidEventPayloadError';
  }
}

/** Función pura: `provider.approved` avisa al usuario aprobado. Sin email ni datos personales. */
export function providerApprovedTemplate(
  event: WireEvent,
): NotificationDraft[] {
  const { userId } = event.payload;
  if (typeof userId !== 'string' || !OBJECT_ID.test(userId)) {
    throw new InvalidEventPayloadError(event.type, 'userId');
  }
  return [
    {
      destinatarioTipo: 'USER',
      destinatarioId: userId,
      plantilla: 'PROVIDER_APPROVED',
      titulo: 'Solicitud aprobada',
      mensaje:
        'Tu solicitud como proveedor fue aprobada. Ya puedes iniciar sesión y crear tu tienda.',
    },
  ];
}

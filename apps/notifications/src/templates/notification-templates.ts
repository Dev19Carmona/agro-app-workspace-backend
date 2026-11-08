import type { WireEvent } from '../../../../libs/common/src/messaging/domain-event.schema.js';
import type {
  DestinatarioTipo,
  Plantilla,
} from '../schemas/notification.schema.js';
import { providerApprovedTemplate } from './provider-approved.template.js';

/** Borrador de aviso que produce una plantilla; el servicio lo guarda como `Notification`. */
export type NotificationDraft = {
  destinatarioTipo: DestinatarioTipo;
  /** ObjectId en hexadecimal (userId o storeId). */
  destinatarioId: string;
  plantilla: Plantilla;
  titulo: string;
  mensaje: string;
};

/** Una plantilla devuelve una lista: el SPEC 10 avisa a varios destinatarios. */
export type NotificationTemplate = (event: WireEvent) => NotificationDraft[];

/** Registro por `type` del evento. */
export const NOTIFICATION_TEMPLATES: Readonly<
  Record<string, NotificationTemplate>
> = {
  'provider.approved': providerApprovedTemplate,
};

export function getTemplate(type: string): NotificationTemplate | undefined {
  return Object.hasOwn(NOTIFICATION_TEMPLATES, type)
    ? NOTIFICATION_TEMPLATES[type]
    : undefined;
}

import type { WireEvent } from '../../../../libs/common/src/messaging/domain-event.schema.js';
import type {
  DestinatarioTipo,
  Plantilla,
} from '../schemas/notification.schema.js';
import { orderCancelledTemplate } from './order-cancelled.template.js';
import { orderConfirmedTemplate } from './order-confirmed.template.js';
import { paymentApprovedTemplate } from './payment-approved.template.js';
import { paymentDeclinedTemplate } from './payment-declined.template.js';
import { providerApprovedTemplate } from './provider-approved.template.js';
import { providerRejectedTemplate } from './provider-rejected.template.js';
import { userRegisteredTemplate } from './user-registered.template.js';

/** Borrador de aviso que produce una plantilla; el servicio lo guarda como `Notification`. */
export type NotificationDraft = {
  destinatarioTipo: DestinatarioTipo;
  /** ObjectId en hexadecimal (userId o storeId). */
  destinatarioId: string;
  plantilla: Plantilla;
  titulo: string;
  mensaje: string;
};

/** Una plantilla devuelve una lista: `order.confirmed` avisa al comprador y a cada tienda. */
export type NotificationTemplate = (event: WireEvent) => NotificationDraft[];

/** Registro por `type` del evento. */
export const NOTIFICATION_TEMPLATES: Readonly<
  Record<string, NotificationTemplate>
> = {
  'user.registered': userRegisteredTemplate,
  'provider.approved': providerApprovedTemplate,
  'provider.rejected': providerRejectedTemplate,
  'payment.approved': paymentApprovedTemplate,
  'payment.declined': paymentDeclinedTemplate,
  'order.confirmed': orderConfirmedTemplate,
  'order.cancelled': orderCancelledTemplate,
};

export function getTemplate(type: string): NotificationTemplate | undefined {
  return Object.hasOwn(NOTIFICATION_TEMPLATES, type)
    ? NOTIFICATION_TEMPLATES[type]
    : undefined;
}

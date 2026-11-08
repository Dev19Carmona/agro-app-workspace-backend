import type { WireEvent } from '../../../../libs/common/src/messaging/domain-event.schema.js';
import { getTemplate } from './notification-templates.js';
import {
  InvalidEventPayloadError,
  providerApprovedTemplate,
} from './provider-approved.template.js';

const USER_ID = '64b7f0c2a1b2c3d4e5f60718';

const event = (payload: Record<string, unknown>): WireEvent => ({
  eventId: '3f1c2d4e-5a6b-4c7d-8e9f-0a1b2c3d4e5f',
  type: 'provider.approved',
  occurredAt: '2026-11-08T10:00:00.000Z',
  correlationId: USER_ID,
  payload,
});

describe('providerApprovedTemplate', () => {
  it('produce el borrador esperado para el usuario aprobado', () => {
    expect(providerApprovedTemplate(event({ userId: USER_ID }))).toEqual([
      {
        destinatarioTipo: 'USER',
        destinatarioId: USER_ID,
        plantilla: 'PROVIDER_APPROVED',
        titulo: 'Solicitud aprobada',
        mensaje:
          'Tu solicitud como proveedor fue aprobada. Ya puedes iniciar sesión y crear tu tienda.',
      },
    ]);
  });

  it.each([undefined, 5, 'corto', 'z'.repeat(24), `${USER_ID}0`])(
    'lanza si el userId no es un ObjectId (%s)',
    (userId) => {
      expect(() => providerApprovedTemplate(event({ userId }))).toThrow(
        InvalidEventPayloadError,
      );
    },
  );

  it('el mensaje no incluye email ni datos personales', () => {
    const [draft] = providerApprovedTemplate(
      event({ userId: USER_ID, email: 'a@b.co' }),
    );
    expect(JSON.stringify(draft)).not.toContain('a@b.co');
  });
});

describe('getTemplate', () => {
  it('devuelve la plantilla de provider.approved', () => {
    expect(getTemplate('provider.approved')).toBe(providerApprovedTemplate);
  });

  it('devuelve undefined para un tipo sin plantilla o heredado de Object', () => {
    expect(getTemplate('order.confirmed')).toBeUndefined();
    expect(getTemplate('constructor')).toBeUndefined();
  });
});

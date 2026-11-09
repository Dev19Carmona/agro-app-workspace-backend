import type { WireEvent } from '../../../../libs/common/src/messaging/domain-event.schema.js';
import { getTemplate } from './notification-templates.js';
import { orderCancelledTemplate } from './order-cancelled.template.js';
import { orderConfirmedTemplate } from './order-confirmed.template.js';
import { InvalidEventPayloadError } from './payload.js';
import { paymentApprovedTemplate } from './payment-approved.template.js';
import { paymentDeclinedTemplate } from './payment-declined.template.js';
import {
  MAX_REASON_LENGTH,
  providerRejectedTemplate,
} from './provider-rejected.template.js';
import { userRegisteredTemplate } from './user-registered.template.js';

const USER = '64b7f0c2a1b2c3d4e5f60718';
const ORDER = '64b7f0c2a1b2c3d4e5f60719';
const PAYMENT = '64b7f0c2a1b2c3d4e5f6071a';
const STORE_A = '64b7f0c2a1b2c3d4e5f6071b';
const STORE_B = '64b7f0c2a1b2c3d4e5f6071c';

const event = (type: string, payload: Record<string, unknown>): WireEvent => ({
  eventId: '3f1c2d4e-5a6b-4c7d-8e9f-0a1b2c3d4e5f',
  type,
  occurredAt: '2026-11-09T10:00:00.000Z',
  correlationId: ORDER,
  payload,
});

describe('user.registered', () => {
  it('PRODUCTOR recibe la bienvenida', () => {
    expect(
      userRegisteredTemplate(
        event('user.registered', {
          userId: USER,
          rol: 'PRODUCTOR',
          status: 'ACTIVE',
        }),
      ),
    ).toEqual([
      {
        destinatarioTipo: 'USER',
        destinatarioId: USER,
        plantilla: 'USER_REGISTERED',
        titulo: 'Bienvenido a Mini-Croper',
        mensaje:
          'Tu cuenta fue creada. Ya puedes explorar el catálogo y hacer pedidos.',
      },
    ]);
  });

  it('PROVEEDOR recibe el acuse de solicitud', () => {
    const [draft] = userRegisteredTemplate(
      event('user.registered', {
        userId: USER,
        rol: 'PROVEEDOR',
        status: 'PENDING_APPROVAL',
      }),
    );
    expect(draft).toMatchObject({
      plantilla: 'USER_REGISTERED',
      titulo: 'Solicitud recibida',
    });
    expect(draft.mensaje).toContain('administrador');
  });

  it.each(['ADMIN', undefined, 'otro'])('lanza con rol %s', (rol) => {
    expect(() =>
      userRegisteredTemplate(event('user.registered', { userId: USER, rol })),
    ).toThrow(InvalidEventPayloadError);
  });

  it('lanza con userId inválido', () => {
    expect(() =>
      userRegisteredTemplate(
        event('user.registered', { userId: 'x', rol: 'PRODUCTOR' }),
      ),
    ).toThrow(InvalidEventPayloadError);
  });
});

describe('provider.rejected', () => {
  it('incluye el motivo cuando existe', () => {
    const [draft] = providerRejectedTemplate(
      event('provider.rejected', { userId: USER, reason: ' Falta el RUT ' }),
    );
    expect(draft).toMatchObject({
      destinatarioTipo: 'USER',
      destinatarioId: USER,
      plantilla: 'PROVIDER_REJECTED',
      titulo: 'Solicitud rechazada',
      mensaje:
        'Tu solicitud como proveedor fue rechazada. Motivo: Falta el RUT.',
    });
  });

  it.each([undefined, '', '   ', 5])('sin motivo útil (%s)', (reason) => {
    const [draft] = providerRejectedTemplate(
      event('provider.rejected', { userId: USER, reason }),
    );
    expect(draft.mensaje).toBe('Tu solicitud como proveedor fue rechazada.');
  });

  it('recorta el motivo a 200 caracteres', () => {
    const [draft] = providerRejectedTemplate(
      event('provider.rejected', { userId: USER, reason: 'a'.repeat(500) }),
    );
    expect(draft.mensaje).toContain('a'.repeat(MAX_REASON_LENGTH));
    expect(draft.mensaje).not.toContain('a'.repeat(MAX_REASON_LENGTH + 1));
  });

  it('lanza con userId inválido', () => {
    expect(() =>
      providerRejectedTemplate(event('provider.rejected', { userId: 'x' })),
    ).toThrow(InvalidEventPayloadError);
  });
});

describe('payment.approved', () => {
  const payload = {
    orderId: ORDER,
    paymentId: PAYMENT,
    buyerId: USER,
    monto: 1250000,
  };

  it('avisa al comprador con el monto formateado', () => {
    expect(paymentApprovedTemplate(event('payment.approved', payload))).toEqual(
      [
        {
          destinatarioTipo: 'USER',
          destinatarioId: USER,
          plantilla: 'PAYMENT_APPROVED',
          titulo: 'Pago recibido',
          mensaje: `Recibimos tu pago de $1.250.000 del pedido ${ORDER}.`,
        },
      ],
    );
  });

  it.each([
    { buyerId: 'x' },
    { orderId: undefined },
    { monto: 10.5 },
    { monto: -1 },
  ])('lanza con payload mal formado %j', (cambio) => {
    expect(() =>
      paymentApprovedTemplate(
        event('payment.approved', { ...payload, ...cambio }),
      ),
    ).toThrow(InvalidEventPayloadError);
  });
});

describe('payment.declined', () => {
  it('avisa al comprador y no muestra el motivo', () => {
    const [draft] = paymentDeclinedTemplate(
      event('payment.declined', {
        orderId: ORDER,
        paymentId: PAYMENT,
        buyerId: USER,
        motivo: 'INSUFFICIENT_FUNDS',
      }),
    );
    expect(draft).toMatchObject({
      destinatarioTipo: 'USER',
      destinatarioId: USER,
      plantilla: 'PAYMENT_DECLINED',
      titulo: 'Pago rechazado',
    });
    expect(draft.mensaje).toContain(ORDER);
    expect(JSON.stringify(draft)).not.toContain('INSUFFICIENT_FUNDS');
  });

  it('lanza sin buyerId válido', () => {
    expect(() =>
      paymentDeclinedTemplate(
        event('payment.declined', { orderId: ORDER, buyerId: undefined }),
      ),
    ).toThrow(InvalidEventPayloadError);
  });
});

describe('order.confirmed', () => {
  const payload = {
    orderId: ORDER,
    buyerId: USER,
    total: 90000,
    storeIds: [STORE_A, STORE_B],
  };

  it('un pedido de dos tiendas produce tres avisos', () => {
    const drafts = orderConfirmedTemplate(event('order.confirmed', payload));

    expect(drafts).toHaveLength(3);
    expect(drafts[0]).toEqual({
      destinatarioTipo: 'USER',
      destinatarioId: USER,
      plantilla: 'ORDER_CONFIRMED_BUYER',
      titulo: 'Pedido confirmado',
      mensaje: `Tu pedido ${ORDER} por $90.000 quedó confirmado.`,
    });
    expect(drafts.slice(1)).toEqual(
      [STORE_A, STORE_B].map((storeId) => ({
        destinatarioTipo: 'STORE',
        destinatarioId: storeId,
        plantilla: 'ORDER_CONFIRMED_STORE',
        titulo: 'Nuevo pedido',
        mensaje: `Tu tienda tiene un pedido confirmado: ${ORDER}.`,
      })),
    );
  });

  it.each([
    { storeIds: [] },
    { storeIds: undefined },
    { storeIds: [STORE_A, 'malo'] },
    { storeIds: [STORE_A, STORE_A] },
    { buyerId: 'x' },
    { total: 1.5 },
  ])('lanza con payload mal formado %j', (cambio) => {
    expect(() =>
      orderConfirmedTemplate(
        event('order.confirmed', { ...payload, ...cambio }),
      ),
    ).toThrow(InvalidEventPayloadError);
  });
});

describe('order.cancelled', () => {
  const base = { orderId: ORDER, buyerId: USER };

  it.each([
    ['STOCK_REJECTED', 'ya no tiene existencias suficientes'],
    ['EXPIRED', 'venció el plazo de pago'],
    ['STOCK_TIMEOUT', 'no pudimos reservar las existencias a tiempo'],
    ['LATE_RESERVATION', 'escríbenos para revisarlo'],
  ])('%s avisa solo al comprador con su propio texto', (motivo, texto) => {
    const drafts = orderCancelledTemplate(
      event('order.cancelled', { ...base, motivo }),
    );

    expect(drafts).toHaveLength(1);
    expect(drafts[0]).toMatchObject({
      destinatarioTipo: 'USER',
      destinatarioId: USER,
      plantilla: 'ORDER_CANCELLED',
      titulo: 'Pedido cancelado',
    });
    expect(drafts[0].mensaje).toContain(ORDER);
    expect(drafts[0].mensaje).toContain(texto);
    expect(drafts[0].mensaje).not.toContain(motivo);
  });

  it.each(['OTRO', undefined, 'constructor'])(
    'lanza con motivo desconocido (%s)',
    (motivo) => {
      expect(() =>
        orderCancelledTemplate(event('order.cancelled', { ...base, motivo })),
      ).toThrow(InvalidEventPayloadError);
    },
  );
});

describe('registro de plantillas', () => {
  it.each([
    'user.registered',
    'provider.approved',
    'provider.rejected',
    'payment.approved',
    'payment.declined',
    'order.confirmed',
    'order.cancelled',
  ])('%s tiene plantilla', (type) => {
    expect(getTemplate(type)).toBeTypeOf('function');
  });

  it.each(['order.created', 'stock.reserved', 'store.created'])(
    '%s no tiene plantilla',
    (type) => {
      expect(getTemplate(type)).toBeUndefined();
    },
  );
});

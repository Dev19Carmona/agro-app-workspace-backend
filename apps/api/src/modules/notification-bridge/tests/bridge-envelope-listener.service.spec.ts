import { BridgeEnvelopeListenerService } from '../services/bridge-envelope-listener.service.js';

const OCCURRED = '2026-11-09T10:00:00.000Z';
const EVENT_ID = '3f2b8c1e-6a4d-4f0a-9b7e-1c2d3e4f5a6b';
const sobre = (type: string, payload: Record<string, unknown>) => ({
  eventId: EVENT_ID,
  type,
  occurredAt: OCCURRED,
  correlationId: 'orden-1',
  payload,
});

describe('BridgeEnvelopeListenerService', () => {
  const outboxModel = { create: vi.fn() };
  let service: BridgeEnvelopeListenerService;

  beforeEach(() => {
    vi.resetAllMocks();
    outboxModel.create.mockResolvedValue({});
    service = new BridgeEnvelopeListenerService(outboxModel as never);
  });

  it.each([
    [
      'onPaymentApproved',
      'payment.approved',
      { orderId: 'o', paymentId: 'p', buyerId: 'b', monto: 5 },
    ],
    [
      'onPaymentDeclined',
      'payment.declined',
      { orderId: 'o', paymentId: 'p', buyerId: 'b', motivo: 'X' },
    ],
    [
      'onOrderConfirmed',
      'order.confirmed',
      { orderId: 'o', buyerId: 'b', total: 5, storeIds: ['s'] },
    ],
    [
      'onOrderCancelled',
      'order.cancelled',
      { orderId: 'o', buyerId: 'b', motivo: 'EXPIRED' },
    ],
  ] as const)(
    '%s conserva el eventId, la fecha y el correlationId del sobre',
    async (method, type, payload) => {
      await service[method](sobre(type, payload));

      const [doc] = outboxModel.create.mock.calls[0];
      expect(doc).toMatchObject({
        eventId: EVENT_ID,
        type,
        correlationId: 'orden-1',
      });
      expect(doc.occurredAt).toEqual(new Date(OCCURRED));
    },
  );

  it('payment.declined no guarda el motivo', async () => {
    await service.onPaymentDeclined(
      sobre('payment.declined', {
        orderId: 'o',
        paymentId: 'p',
        buyerId: 'b',
        motivo: 'FONDOS',
      }),
    );

    expect(outboxModel.create.mock.calls[0][0].payload).not.toHaveProperty(
      'motivo',
    );
  });

  it('ignora el 11000: el mismo evento dos veces no falla ni duplica', async () => {
    outboxModel.create.mockRejectedValue({ code: 11000 });

    await expect(
      service.onOrderCancelled(
        sobre('order.cancelled', {
          orderId: 'o',
          buyerId: 'b',
          motivo: 'EXPIRED',
        }),
      ),
    ).resolves.toBeUndefined();
  });

  it('relanza otros errores para que el origen reintente, sin payload en el log', async () => {
    const error = Object.assign(new Error('falla'), {
      name: 'MongoServerError',
    });
    outboxModel.create.mockRejectedValue(error);
    const logSpy = vi
      .spyOn(service['logger'], 'error')
      .mockImplementation(() => {});

    await expect(
      service.onOrderConfirmed(
        sobre('order.confirmed', {
          orderId: 'o',
          buyerId: 'comprador-secreto',
          total: 5,
          storeIds: ['s'],
        }),
      ),
    ).rejects.toBe(error);

    expect(JSON.stringify(logSpy.mock.calls)).not.toContain(
      'comprador-secreto',
    );
  });
});

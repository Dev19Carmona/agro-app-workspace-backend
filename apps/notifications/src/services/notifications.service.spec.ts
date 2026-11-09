import type { WireEvent } from '../../../../libs/common/src/messaging/domain-event.schema.js';
import { NotificationsService } from './notifications.service.js';

const USER_ID = '64b7f0c2a1b2c3d4e5f60718';

const event = (
  payload: Record<string, unknown> = { userId: USER_ID },
): WireEvent => ({
  eventId: '3f1c2d4e-5a6b-4c7d-8e9f-0a1b2c3d4e5f',
  type: 'provider.approved',
  occurredAt: '2026-11-08T10:00:00.000Z',
  correlationId: USER_ID,
  payload,
});

describe('NotificationsService.handle', () => {
  const model = { create: vi.fn() };
  let service: NotificationsService;
  let log: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    vi.resetAllMocks();
    model.create.mockResolvedValue({});
    service = new NotificationsService(model as never);
    log = vi.spyOn(service['logger'], 'log').mockImplementation(() => {});
  });

  it('inserta el aviso SIMULATED con sentAt y los datos del evento', async () => {
    const antes = Date.now();

    await service.handle(event());

    const [doc] = model.create.mock.calls[0];
    expect(doc).toMatchObject({
      eventId: '3f1c2d4e-5a6b-4c7d-8e9f-0a1b2c3d4e5f',
      eventType: 'provider.approved',
      correlationId: USER_ID,
      destinatarioTipo: 'USER',
      destinatarioId: USER_ID,
      plantilla: 'PROVIDER_APPROVED',
      titulo: 'Solicitud aprobada',
      canal: 'SIMULATED',
    });
    expect(doc.sentAt.getTime()).toBeGreaterThanOrEqual(antes);
  });

  it('deja un log con plantilla y destinatario pero sin el mensaje', async () => {
    await service.handle(event());

    const logged = JSON.stringify(log.mock.calls);
    expect(logged).toContain('PROVIDER_APPROVED');
    expect(logged).toContain('USER');
    expect(logged).toContain(USER_ID);
    expect(logged).not.toContain('Tu solicitud');
  });

  it('un evento repetido (11000) no duplica ni lanza', async () => {
    model.create.mockRejectedValue({ code: 11000 });

    await expect(service.handle(event())).resolves.toBeUndefined();
    expect(log).not.toHaveBeenCalled();
  });

  describe('order.confirmed (varios avisos)', () => {
    const BUYER = '64b7f0c2a1b2c3d4e5f60719';
    const STORE_A = '64b7f0c2a1b2c3d4e5f6071b';
    const STORE_B = '64b7f0c2a1b2c3d4e5f6071c';
    const confirmado = (): WireEvent => ({
      eventId: '3f1c2d4e-5a6b-4c7d-8e9f-0a1b2c3d4e5f',
      type: 'order.confirmed',
      occurredAt: '2026-11-09T10:00:00.000Z',
      correlationId: USER_ID,
      payload: {
        orderId: USER_ID,
        buyerId: BUYER,
        total: 5000,
        storeIds: [STORE_A, STORE_B],
      },
    });

    it('guarda un aviso para el comprador y uno por tienda', async () => {
      await service.handle(confirmado());

      const docs = model.create.mock.calls.map(([d]) => d);
      expect(docs.map((d) => [d.destinatarioTipo, d.destinatarioId])).toEqual([
        ['USER', BUYER],
        ['STORE', STORE_A],
        ['STORE', STORE_B],
      ]);
      expect(new Set(docs.map((d) => d.eventId)).size).toBe(1);
    });

    it('un reintento con un aviso ya guardado crea los demás sin duplicar', async () => {
      model.create
        .mockRejectedValueOnce({ code: 11000 }) // comprador ya guardado
        .mockResolvedValue({});

      await expect(service.handle(confirmado())).resolves.toBeUndefined();

      expect(model.create).toHaveBeenCalledTimes(3);
      expect(log).toHaveBeenCalledTimes(2); // solo loguea los nuevos
    });

    it('si falla uno con otro error, relanza (el consumidor reintenta)', async () => {
      const error = new Error('mongo caído');
      model.create.mockResolvedValueOnce({}).mockRejectedValueOnce(error);

      await expect(service.handle(confirmado())).rejects.toBe(error);
    });
  });

  it('relanza cualquier otro error de Mongo', async () => {
    const error = new Error('mongo caído');
    model.create.mockRejectedValue(error);

    await expect(service.handle(event())).rejects.toBe(error);
  });

  it('lanza si el userId es inválido y no inserta', async () => {
    await expect(
      service.handle(event({ userId: 'no-es-oid' })),
    ).rejects.toThrow(/userId/);
    expect(model.create).not.toHaveBeenCalled();
  });

  it('lanza si el tipo no tiene plantilla', async () => {
    await expect(
      service.handle({ ...event(), type: 'order.created' }),
    ).rejects.toThrow(/Sin plantilla/);
  });
});

import { OutboxService } from '../services/outbox.service.js';

const UUID_V4 =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

describe('OutboxService.add', () => {
  const outboxModel = { create: vi.fn() };
  const session = { id: 'sesion' };
  let service: OutboxService;

  beforeEach(() => {
    vi.resetAllMocks();
    outboxModel.create.mockResolvedValue([]);
    service = new OutboxService(outboxModel as never);
  });

  it('inserta el evento PENDING con eventId uuid, 0 intentos y nextAttemptAt ahora', async () => {
    const antes = Date.now();

    const eventId = await service.add(session as never, 'order.created', 'o1', {
      orderId: 'o1',
    });

    expect(eventId).toMatch(UUID_V4);
    const [[doc], options] = outboxModel.create.mock.calls[0];
    expect(doc).toMatchObject({
      eventId,
      type: 'order.created',
      correlationId: 'o1',
      payload: { orderId: 'o1' },
      status: 'PENDING',
      attempts: 0,
    });
    expect(doc.nextAttemptAt.getTime()).toBeGreaterThanOrEqual(antes);
    expect(doc.occurredAt).toBeInstanceOf(Date);
    expect(options).toEqual({ session });
  });

  it('genera un eventId distinto en cada alta', async () => {
    const a = await service.add(session as never, 'order.cancelled', 'o1', {});
    const b = await service.add(session as never, 'order.cancelled', 'o1', {});

    expect(a).not.toBe(b);
  });

  it('propaga el error del insert para abortar la transacción', async () => {
    outboxModel.create.mockRejectedValue(new Error('boom'));

    await expect(
      service.add(session as never, 'order.confirmed', 'o1', {}),
    ).rejects.toThrow('boom');
  });
});

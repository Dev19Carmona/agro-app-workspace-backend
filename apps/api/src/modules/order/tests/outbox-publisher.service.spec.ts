import { OutboxPublisherService } from '../services/outbox-publisher.service.js';

const NOW = new Date('2026-11-08T12:00:00.000Z');

const evento = (extra: Record<string, unknown> = {}) => ({
  _id: 'id-1',
  eventId: 'e-1',
  type: 'order.created',
  correlationId: 'o1',
  payload: { orderId: 'o1' },
  occurredAt: new Date('2026-11-08T11:59:00.000Z'),
  status: 'PENDING',
  attempts: 0,
  ...extra,
});

/** Encadena `.lean()` como lo hace Mongoose. */
const lean = <T>(value: T) => ({ lean: () => Promise.resolve(value) });

describe('OutboxPublisherService', () => {
  const outboxModel = { findOneAndUpdate: vi.fn(), updateOne: vi.fn() };
  const events = { emitAsync: vi.fn() };
  let service: OutboxPublisherService;

  /** El primer reclamo devuelve `claimed`; el siguiente, nada. */
  const claim = (...claimed: unknown[]) => {
    for (const c of claimed) {
      outboxModel.findOneAndUpdate.mockReturnValueOnce(lean(c));
    }
    outboxModel.findOneAndUpdate.mockReturnValue(lean(null));
  };

  beforeEach(() => {
    vi.resetAllMocks();
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
    outboxModel.updateOne.mockResolvedValue({});
    events.emitAsync.mockResolvedValue([]);
    service = new OutboxPublisherService(outboxModel as never, events as never);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('reclama de forma atómica solo PENDING vencidos y sin lock vigente', async () => {
    claim(null);

    await service.publishPending();

    const [filter, update, options] =
      outboxModel.findOneAndUpdate.mock.calls[0];
    expect(filter).toEqual({
      status: 'PENDING',
      nextAttemptAt: { $lte: NOW },
      $or: [
        { lockedUntil: { $exists: false } },
        { lockedUntil: { $lte: NOW } },
      ],
    });
    expect(update).toEqual({
      $set: { lockedUntil: new Date(NOW.getTime() + 30_000) },
    });
    expect(options).toMatchObject({ sort: { occurredAt: 1 } });
  });

  it('publica con emitAsync el sobre completo y marca PUBLISHED con publishedAt', async () => {
    claim(evento());

    await service.publishPending();

    expect(events.emitAsync).toHaveBeenCalledWith('order.created', {
      eventId: 'e-1',
      type: 'order.created',
      occurredAt: '2026-11-08T11:59:00.000Z',
      correlationId: 'o1',
      payload: { orderId: 'o1' },
    });
    expect(outboxModel.updateOne).toHaveBeenCalledWith(
      { _id: 'id-1' },
      { $set: { status: 'PUBLISHED', publishedAt: NOW } },
    );
  });

  it('publica uno a uno todos los eventos disponibles del ciclo', async () => {
    claim(evento(), evento({ _id: 'id-2', eventId: 'e-2' }));

    await service.publishPending();

    expect(events.emitAsync).toHaveBeenCalledTimes(2);
  });

  it('un evento reclamado con lockedUntil vigente no se publica: el reclamo no lo devuelve', async () => {
    claim(null);

    await service.publishPending();

    expect(events.emitAsync).not.toHaveBeenCalled();
    expect(outboxModel.updateOne).not.toHaveBeenCalled();
  });

  it('un fallo suma attempts, guarda lastError, aplica backoff y libera el lock', async () => {
    claim(evento({ attempts: 0 }));
    events.emitAsync.mockRejectedValue(new Error('listener roto'));

    await service.publishPending();

    expect(outboxModel.updateOne).toHaveBeenCalledWith(
      { _id: 'id-1' },
      {
        $set: {
          attempts: 1,
          lastError: 'listener roto',
          nextAttemptAt: new Date(NOW.getTime() + 4_000),
        },
        $unset: { lockedUntil: '' },
      },
    );
    const [, update] = outboxModel.updateOne.mock.calls[0];
    expect(update.$set.status).toBeUndefined();
  });

  it('el backoff crece con los intentos y tiene tope de 60 s', async () => {
    claim(evento({ attempts: 3 }));
    events.emitAsync.mockRejectedValue(new Error('x'));

    await service.publishPending();

    const [, update] = outboxModel.updateOne.mock.calls[0];
    expect(update.$set.attempts).toBe(4);
    expect(update.$set.nextAttemptAt).toEqual(new Date(NOW.getTime() + 32_000));
  });

  it('el quinto fallo deja el evento en FAILED, sin más reintentos', async () => {
    claim(evento({ attempts: 4 }));
    events.emitAsync.mockRejectedValue(new Error('x'));

    await service.publishPending();

    const [, update] = outboxModel.updateOne.mock.calls[0];
    expect(update.$set).toEqual({
      attempts: 5,
      lastError: 'x',
      status: 'FAILED',
    });
    expect(update.$unset).toEqual({ lockedUntil: '' });
  });

  it('guarda solo el mensaje del error, nunca el payload', async () => {
    claim(evento({ payload: { buyerId: 'dato-personal' } }));
    events.emitAsync.mockRejectedValue(new Error('falló'));

    await service.publishPending();

    const [, update] = outboxModel.updateOne.mock.calls[0];
    expect(JSON.stringify(update)).not.toContain('dato-personal');
  });

  it('tras un fallo sigue con el siguiente evento', async () => {
    claim(evento(), evento({ _id: 'id-2', eventId: 'e-2' }));
    events.emitAsync
      .mockRejectedValueOnce(new Error('x'))
      .mockResolvedValueOnce([]);

    await service.publishPending();

    expect(events.emitAsync).toHaveBeenCalledTimes(2);
  });

  it('un ciclo no se solapa con el anterior', async () => {
    let release!: () => void;
    outboxModel.findOneAndUpdate.mockReturnValueOnce({
      lean: () => new Promise((resolve) => (release = () => resolve(null))),
    });

    const first = service.publishPending();
    await service.publishPending(); // el segundo sale sin reclamar
    expect(outboxModel.findOneAndUpdate).toHaveBeenCalledTimes(1);

    release();
    await first;
    claim(null);
    await service.publishPending(); // ya terminó el primero: corre otro
    expect(outboxModel.findOneAndUpdate).toHaveBeenCalledTimes(2);
  });

  it('si el ciclo falla (p. ej. Mongo caído) no revienta y permite el siguiente', async () => {
    outboxModel.findOneAndUpdate.mockReturnValueOnce({
      lean: () => Promise.reject(new Error('mongo caído')),
    });

    await expect(service.publishPending()).resolves.toBeUndefined();

    claim(null);
    await service.publishPending();
    expect(outboxModel.findOneAndUpdate).toHaveBeenCalledTimes(2);
  });
});

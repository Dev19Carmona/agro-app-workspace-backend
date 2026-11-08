import { BridgePublisherService } from '../services/bridge-publisher.service.js';

const NOW = new Date('2026-11-08T12:00:00.000Z');

const evento = (extra: Record<string, unknown> = {}) => ({
  _id: 'id-1',
  eventId: 'e-1',
  type: 'provider.approved',
  correlationId: 'u1',
  payload: { userId: 'u1', reviewedBy: 'a1' },
  occurredAt: new Date('2026-11-08T11:59:00.000Z'),
  status: 'PENDING',
  attempts: 0,
  ...extra,
});

/** Encadena `.lean()` como lo hace Mongoose. */
const lean = <T>(value: T) => ({ lean: () => Promise.resolve(value) });

describe('BridgePublisherService', () => {
  const outboxModel = { findOneAndUpdate: vi.fn(), updateOne: vi.fn() };
  const publisher = { isConnected: vi.fn(), publish: vi.fn() };
  let service: BridgePublisherService;

  /** Cada reclamo devuelve un evento; después, nada. */
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
    publisher.isConnected.mockReturnValue(true);
    publisher.publish.mockResolvedValue(undefined);
    service = new BridgePublisherService(
      outboxModel as never,
      publisher as never,
    );
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('reclama de forma atómica solo PENDING vencidos y sin lock vigente', async () => {
    claim();

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

  it('publica el sobre y marca PUBLISHED con publishedAt', async () => {
    claim(evento());

    await service.publishPending();

    expect(publisher.publish).toHaveBeenCalledWith({
      eventId: 'e-1',
      type: 'provider.approved',
      occurredAt: '2026-11-08T11:59:00.000Z',
      correlationId: 'u1',
      payload: { userId: 'u1', reviewedBy: 'a1' },
    });
    expect(outboxModel.updateOne).toHaveBeenCalledWith(
      { _id: 'id-1' },
      {
        $set: { status: 'PUBLISHED', publishedAt: NOW },
        $unset: { lockedUntil: '' },
      },
    );
  });

  it('un fallo con el broker conectado suma intento, guarda lastError y aplica backoff', async () => {
    claim(evento({ attempts: 1 }));
    publisher.publish.mockRejectedValue(new Error('nack'));

    await service.publishPending();

    expect(outboxModel.updateOne).toHaveBeenCalledWith(
      { _id: 'id-1' },
      {
        $set: {
          attempts: 2,
          lastError: 'nack',
          nextAttemptAt: new Date(NOW.getTime() + 8_000),
        },
        $unset: { lockedUntil: '' },
      },
    );
  });

  it('el quinto fallo deja el evento en FAILED sin nextAttemptAt', async () => {
    claim(evento({ attempts: 4 }));
    publisher.publish.mockRejectedValue(new Error('nack'));

    await service.publishPending();

    const [, update] = outboxModel.updateOne.mock.calls[0];
    expect(update.$set).toEqual({
      attempts: 5,
      lastError: 'nack',
      status: 'FAILED',
    });
  });

  it('no registra el payload en lastError ni en los logs', async () => {
    claim(evento());
    publisher.publish.mockRejectedValue(new Error('nack'));
    const warn = vi
      .spyOn(service['logger'], 'warn')
      .mockImplementation(() => {});

    await service.publishPending();

    expect(JSON.stringify(warn.mock.calls)).not.toContain('u1');
    expect(JSON.stringify(outboxModel.updateOne.mock.calls)).not.toContain(
      'reviewedBy',
    );
  });

  it('con el broker desconectado salta el ciclo sin reclamar ni cambiar attempts', async () => {
    publisher.isConnected.mockReturnValue(false);
    const warn = vi
      .spyOn(service['logger'], 'warn')
      .mockImplementation(() => {});

    await service.publishPending();

    expect(outboxModel.findOneAndUpdate).not.toHaveBeenCalled();
    expect(outboxModel.updateOne).not.toHaveBeenCalled();
    expect(warn).toHaveBeenCalled();
  });

  it('si el broker cae a mitad de la publicación libera el evento sin gastar intento', async () => {
    claim(evento());
    publisher.isConnected.mockReturnValueOnce(true).mockReturnValue(false);
    publisher.publish.mockRejectedValue(new Error('canal cerrado'));

    await service.publishPending();

    expect(outboxModel.updateOne).toHaveBeenCalledTimes(1);
    expect(outboxModel.updateOne).toHaveBeenCalledWith(
      { _id: 'id-1' },
      { $unset: { lockedUntil: '' } },
    );
  });

  it('un evento bloqueado no se reclama: sin candidatos no publica nada', async () => {
    claim();

    await service.publishPending();

    expect(publisher.publish).not.toHaveBeenCalled();
    expect(outboxModel.updateOne).not.toHaveBeenCalled();
  });

  it('no se solapa con un ciclo en curso', async () => {
    let liberar!: () => void;
    outboxModel.findOneAndUpdate.mockReturnValueOnce({
      lean: () => new Promise((resolve) => (liberar = () => resolve(null))),
    });

    const primero = service.publishPending();
    await service.publishPending();
    expect(outboxModel.findOneAndUpdate).toHaveBeenCalledTimes(1);

    liberar();
    await primero;
  });

  it('un error inesperado no rompe el job y permite el siguiente ciclo', async () => {
    outboxModel.findOneAndUpdate.mockReturnValueOnce({
      lean: () => Promise.reject(new Error('mongo caído')),
    });
    const error = vi
      .spyOn(service['logger'], 'error')
      .mockImplementation(() => {});

    await expect(service.publishPending()).resolves.toBeUndefined();
    expect(error).toHaveBeenCalled();

    claim();
    await service.publishPending();
    expect(outboxModel.findOneAndUpdate).toHaveBeenCalledTimes(2);
  });
});

import { BridgeListenerService } from '../services/bridge-listener.service.js';

const UUID_V4 =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

describe('BridgeListenerService.onProviderApproved', () => {
  const outboxModel = { create: vi.fn() };
  let service: BridgeListenerService;
  const event = {
    userId: 'u1',
    email: 'proveedor@correo.co',
    reviewedBy: 'a1',
  };

  beforeEach(() => {
    vi.resetAllMocks();
    outboxModel.create.mockResolvedValue({});
    service = new BridgeListenerService(outboxModel as never);
  });

  it('guarda el sobre sin email, con eventId uuid y correlationId = userId', async () => {
    const antes = Date.now();

    await service.onProviderApproved(event);

    const [doc] = outboxModel.create.mock.calls[0];
    expect(doc.eventId).toMatch(UUID_V4);
    expect(doc).toMatchObject({
      type: 'provider.approved',
      correlationId: 'u1',
      payload: { userId: 'u1', reviewedBy: 'a1' },
    });
    expect(doc.payload).not.toHaveProperty('email');
    expect(JSON.stringify(doc)).not.toContain('proveedor@correo.co');
    expect(doc.occurredAt.getTime()).toBeGreaterThanOrEqual(antes);
  });

  it('genera un eventId distinto en cada evento', async () => {
    await service.onProviderApproved(event);
    await service.onProviderApproved(event);

    const [[a], [b]] = outboxModel.create.mock.calls;
    expect(a.eventId).not.toBe(b.eventId);
  });

  it('ignora el error 11000 (reenvío)', async () => {
    outboxModel.create.mockRejectedValue({ code: 11000 });

    await expect(service.onProviderApproved(event)).resolves.toBeUndefined();
  });

  it('relanza cualquier otro error y lo registra sin payload', async () => {
    const error = Object.assign(new Error('falla con proveedor@correo.co'), {
      name: 'MongoServerError',
    });
    outboxModel.create.mockRejectedValue(error);
    const logSpy = vi
      .spyOn(service['logger'], 'error')
      .mockImplementation(() => {});

    await expect(service.onProviderApproved(event)).rejects.toBe(error);

    const logged = JSON.stringify(logSpy.mock.calls);
    expect(logged).toContain('provider.approved');
    expect(logged).not.toContain('proveedor@correo.co');
    expect(logged).not.toContain('u1');
  });
});

describe('BridgeListenerService (user.registered y provider.rejected)', () => {
  const outboxModel = { create: vi.fn() };
  let service: BridgeListenerService;

  beforeEach(() => {
    vi.resetAllMocks();
    outboxModel.create.mockResolvedValue({});
    service = new BridgeListenerService(outboxModel as never);
  });

  it('user.registered: eventId nuevo, correlationId = userId y sin email', async () => {
    await service.onUserRegistered({
      userId: 'u1',
      email: 'a@b.co',
      rol: 'PROVEEDOR',
      status: 'PENDING_APPROVAL',
    } as never);

    const [doc] = outboxModel.create.mock.calls[0];
    expect(doc.eventId).toMatch(UUID_V4);
    expect(doc).toMatchObject({
      type: 'user.registered',
      correlationId: 'u1',
      payload: { userId: 'u1', rol: 'PROVEEDOR', status: 'PENDING_APPROVAL' },
    });
    expect(JSON.stringify(doc)).not.toContain('a@b.co');
  });

  it('provider.rejected: conserva reason y descarta email', async () => {
    await service.onProviderRejected({
      userId: 'u1',
      email: 'a@b.co',
      reviewedBy: 'adm',
      reason: 'Falta RUT',
    });

    const [doc] = outboxModel.create.mock.calls[0];
    expect(doc.payload).toEqual({
      userId: 'u1',
      reviewedBy: 'adm',
      reason: 'Falta RUT',
    });
  });

  it('ignora el 11000 y relanza otros errores', async () => {
    outboxModel.create.mockRejectedValueOnce({ code: 11000 });
    await expect(
      service.onProviderRejected({ userId: 'u1', email: 'x', reviewedBy: 'a' }),
    ).resolves.toBeUndefined();

    const error = new Error('boom');
    outboxModel.create.mockRejectedValueOnce(error);
    vi.spyOn(service['logger'], 'error').mockImplementation(() => {});
    await expect(
      service.onUserRegistered({
        userId: 'u1',
        email: 'x',
        rol: 'PRODUCTOR',
        status: 'ACTIVE',
      } as never),
    ).rejects.toBe(error);
  });
});

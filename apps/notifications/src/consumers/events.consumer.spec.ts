import type { ConsumeMessage } from 'amqplib';
import { EventsConsumer } from './events.consumer.js';

const USER_ID = '64b7f0c2a1b2c3d4e5f60718';

const wire = (extra: Record<string, unknown> = {}) => ({
  eventId: '3f1c2d4e-5a6b-4c7d-8e9f-0a1b2c3d4e5f',
  type: 'provider.approved',
  occurredAt: '2026-11-08T10:00:00.000Z',
  correlationId: USER_ID,
  payload: { userId: USER_ID },
  ...extra,
});

const message = (body: unknown, acquired?: number): ConsumeMessage =>
  ({
    content: Buffer.from(
      typeof body === 'string' ? body : JSON.stringify(body),
    ),
    properties: {
      headers: acquired === undefined ? {} : { 'x-acquired-count': acquired },
    },
  }) as unknown as ConsumeMessage;

describe('EventsConsumer', () => {
  const channel = {
    ack: vi.fn(),
    nack: vi.fn(),
    prefetch: vi.fn(),
    consume: vi.fn(),
    assertExchange: vi.fn(),
    assertQueue: vi.fn(),
    bindQueue: vi.fn(),
  };
  const connection = { onConnect: vi.fn(), start: vi.fn(), close: vi.fn() };
  const notifications = { handle: vi.fn() };
  let consumer: EventsConsumer;
  let warn: ReturnType<typeof vi.spyOn>;
  let error: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    vi.resetAllMocks();
    notifications.handle.mockResolvedValue(undefined);
    consumer = new EventsConsumer(connection as never, notifications as never);
    warn = vi.spyOn(consumer['logger'], 'warn').mockImplementation(() => {});
    error = vi.spyOn(consumer['logger'], 'error').mockImplementation(() => {});
  });

  it('con un mensaje válido guarda el aviso y confirma (ack) después', async () => {
    const msg = message(wire());
    const orden: string[] = [];
    notifications.handle.mockImplementation(async () => {
      orden.push('handle');
    });
    channel.ack.mockImplementation(() => orden.push('ack'));

    await consumer.handleMessage(channel as never, msg);

    expect(notifications.handle).toHaveBeenCalledWith(wire());
    expect(channel.ack).toHaveBeenCalledWith(msg);
    expect(orden).toEqual(['handle', 'ack']);
    expect(channel.nack).not.toHaveBeenCalled();
  });

  it('un 11000 se trata como ya procesado: ack', async () => {
    notifications.handle.mockRejectedValue({ code: 11000 });
    const msg = message(wire());

    await consumer.handleMessage(channel as never, msg);

    expect(channel.ack).toHaveBeenCalledWith(msg);
    expect(channel.nack).not.toHaveBeenCalled();
  });

  it('una excepción en la 1.ª entrega hace nack con requeue y registra eventId y type sin payload', async () => {
    const fallo = Object.assign(new Error(`userId ${USER_ID}`), {
      name: 'Boom',
    });
    notifications.handle.mockRejectedValue(fallo);
    const msg = message(wire());

    await consumer.handleMessage(channel as never, msg);

    expect(channel.nack).toHaveBeenCalledWith(msg, false, true);
    expect(channel.ack).not.toHaveBeenCalled();
    const logged = JSON.stringify(error.mock.calls);
    expect(logged).toContain('3f1c2d4e-5a6b-4c7d-8e9f-0a1b2c3d4e5f');
    expect(logged).toContain('provider.approved');
    expect(logged).not.toContain(USER_ID);
  });

  it('la 2.ª entrega fallida (x-acquired-count 1) sigue con requeue', async () => {
    notifications.handle.mockRejectedValue(new Error('boom'));
    const msg = message(wire(), 1);

    await consumer.handleMessage(channel as never, msg);

    expect(channel.nack).toHaveBeenCalledWith(msg, false, true);
  });

  it('la 3.ª entrega fallida (x-acquired-count 2) va a la DLQ: nack sin requeue', async () => {
    notifications.handle.mockRejectedValue(new Error('boom'));
    const msg = message(wire(), 2);

    await consumer.handleMessage(channel as never, msg);

    expect(channel.nack).toHaveBeenCalledWith(msg, false, false);
    expect(channel.ack).not.toHaveBeenCalled();
  });

  it.each([
    ['JSON roto', '{no es json'],
    ['sobre con propiedad de más', wire({ extra: 1 })],
    ['eventId que no es uuid', wire({ eventId: 'abc' })],
  ])('%s va directo a la DLQ: nack sin requeue', async (_, body) => {
    const msg = message(body);

    await consumer.handleMessage(channel as never, msg);

    expect(channel.nack).toHaveBeenCalledWith(msg, false, false);
    expect(channel.ack).not.toHaveBeenCalled();
    expect(notifications.handle).not.toHaveBeenCalled();
  });

  it('un evento sin plantilla se confirma con warn y no se procesa', async () => {
    const msg = message(wire({ type: 'order.confirmed' }));

    await consumer.handleMessage(channel as never, msg);

    expect(channel.ack).toHaveBeenCalledWith(msg);
    expect(notifications.handle).not.toHaveBeenCalled();
    expect(JSON.stringify(warn.mock.calls)).toContain('order.confirmed');
  });

  it('si el canal está cerrado, ack no rompe el consumidor', async () => {
    channel.ack.mockImplementation(() => {
      throw new Error('Channel closed');
    });

    await expect(
      consumer.handleMessage(channel as never, message(wire())),
    ).resolves.toBeUndefined();
  });

  it('al arrancar declara la topología, fija prefetch 10 y consume con noAck false', async () => {
    channel.assertExchange.mockResolvedValue({});
    channel.assertQueue.mockResolvedValue({});
    channel.bindQueue.mockResolvedValue({});
    await consumer.onApplicationBootstrap();
    expect(connection.start).toHaveBeenCalledTimes(1);

    const [[onConnect]] = connection.onConnect.mock.calls;
    await onConnect(channel);

    expect(channel.assertQueue).toHaveBeenCalled();
    expect(channel.prefetch).toHaveBeenCalledWith(10);
    const [queue, callback, options] = channel.consume.mock.calls[0];
    expect(queue).toBe('notifications.events');
    expect(options).toEqual({ noAck: false });

    // El callback procesa el mensaje y se ignora la cancelación (msg null).
    callback(null);
    callback(message(wire()));
    await vi.waitFor(() => expect(channel.ack).toHaveBeenCalledTimes(1));
  });

  it('al apagar cierra la conexión', async () => {
    await consumer.onApplicationShutdown();
    expect(connection.close).toHaveBeenCalledTimes(1);
  });
});

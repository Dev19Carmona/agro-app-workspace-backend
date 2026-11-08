import { RabbitMqEventPublisher } from '../services/rabbitmq-event-publisher.service.js';

const event = {
  eventId: '3f1c2d4e-5a6b-4c7d-8e9f-0a1b2c3d4e5f',
  type: 'provider.approved',
  occurredAt: '2026-11-08T10:00:00.000Z',
  correlationId: 'u1',
  payload: { userId: 'u1', reviewedBy: 'a1' },
};

describe('RabbitMqEventPublisher', () => {
  const channel = { publish: vi.fn(), waitForConfirms: vi.fn() };
  const connection = {
    getChannel: vi.fn(),
    isConnected: vi.fn(),
    onConnect: vi.fn(),
    start: vi.fn(),
    close: vi.fn(),
  };
  let publisher: RabbitMqEventPublisher;

  beforeEach(() => {
    vi.resetAllMocks();
    connection.getChannel.mockReturnValue(channel);
    channel.waitForConfirms.mockResolvedValue(undefined);
    publisher = new RabbitMqEventPublisher(connection as never);
  });

  it('publica en el exchange con la routing key del type, persistente y con messageId', async () => {
    await publisher.publish(event);

    const [exchange, routingKey, body, options] = channel.publish.mock.calls[0];
    expect(exchange).toBe('mini-croper.events');
    expect(routingKey).toBe('provider.approved');
    expect(JSON.parse(body.toString('utf8'))).toEqual(event);
    expect(options).toEqual({
      persistent: true,
      contentType: 'application/json',
      messageId: event.eventId,
      type: 'provider.approved',
      correlationId: 'u1',
    });
  });

  it('espera la confirmación del broker antes de resolver', async () => {
    let confirmar!: () => void;
    channel.waitForConfirms.mockReturnValue(
      new Promise<void>((resolve) => (confirmar = resolve)),
    );
    let resuelto = false;

    const promesa = publisher.publish(event).then(() => (resuelto = true));
    await Promise.resolve();
    expect(resuelto).toBe(false);

    confirmar();
    await promesa;
    expect(resuelto).toBe(true);
  });

  it('rechaza si el broker hace nack', async () => {
    channel.waitForConfirms.mockRejectedValue(new Error('message nacked'));

    await expect(publisher.publish(event)).rejects.toThrow('nacked');
  });

  it('rechaza si no hay conexión', async () => {
    connection.getChannel.mockImplementation(() => {
      throw new Error('RabbitMQ no está conectado');
    });

    await expect(publisher.publish(event)).rejects.toThrow(/no está conectado/);
  });

  it('isConnected refleja la conexión', () => {
    connection.isConnected.mockReturnValue(true);
    expect(publisher.isConnected()).toBe(true);
    connection.isConnected.mockReturnValue(false);
    expect(publisher.isConnected()).toBe(false);
  });

  it('al iniciar declara la topología en cada canal y conecta; al apagar cierra', async () => {
    await publisher.onModuleInit();
    expect(connection.start).toHaveBeenCalledTimes(1);

    const fakeChannel = {
      assertExchange: vi.fn().mockResolvedValue({}),
      assertQueue: vi.fn().mockResolvedValue({}),
      bindQueue: vi.fn().mockResolvedValue({}),
    };
    const [[onConnect]] = connection.onConnect.mock.calls;
    await onConnect(fakeChannel);
    expect(fakeChannel.assertExchange).toHaveBeenCalledWith(
      'mini-croper.events',
      'topic',
      { durable: true },
    );

    await publisher.onModuleDestroy();
    expect(connection.close).toHaveBeenCalledTimes(1);
  });
});

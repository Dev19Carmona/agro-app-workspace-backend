import { EventEmitter } from 'node:events';
import { connect } from 'amqplib';
import { RabbitMqConnection } from './rabbitmq-connection.js';

vi.mock('amqplib', () => ({ connect: vi.fn() }));

class FakeChannel extends EventEmitter {}

class FakeConnection extends EventEmitter {
  channel = new FakeChannel();
  createConfirmChannel = vi.fn().mockImplementation(async () => this.channel);
  close = vi.fn().mockImplementation(async () => {
    this.emit('close');
  });
}

const connectMock = vi.mocked(connect);
const URI = 'amqp://usuario:secreto@localhost:5672';

function queueConnections(...connections: FakeConnection[]) {
  for (const c of connections) {
    connectMock.mockResolvedValueOnce(c as never);
  }
}

describe('RabbitMqConnection', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    connectMock.mockReset();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('conecta, crea el canal de confirmaciones y refleja el estado', async () => {
    const conn = new FakeConnection();
    queueConnections(conn);
    const rabbit = new RabbitMqConnection(URI);

    expect(rabbit.isConnected()).toBe(false);
    await rabbit.start();

    expect(connectMock).toHaveBeenCalledWith(URI);
    expect(conn.createConfirmChannel).toHaveBeenCalledTimes(1);
    expect(rabbit.isConnected()).toBe(true);
    expect(rabbit.getChannel()).toBe(conn.channel);
    await rabbit.close();
  });

  it('getChannel lanza si no hay conexión', () => {
    expect(() => new RabbitMqConnection(URI).getChannel()).toThrow(
      /no está conectado/,
    );
  });

  it('llama a los listeners con cada canal nuevo', async () => {
    const conn = new FakeConnection();
    queueConnections(conn);
    const rabbit = new RabbitMqConnection(URI);
    const listener = vi.fn();
    rabbit.onConnect(listener);

    await rabbit.start();

    expect(listener).toHaveBeenCalledWith(conn.channel);
    await rabbit.close();
  });

  it('reconecta a los 5 s tras un close y vuelve a llamar a los listeners', async () => {
    const first = new FakeConnection();
    const second = new FakeConnection();
    queueConnections(first, second);
    const rabbit = new RabbitMqConnection(URI);
    const listener = vi.fn();
    rabbit.onConnect(listener);
    await rabbit.start();

    first.emit('close');
    expect(rabbit.isConnected()).toBe(false);

    await vi.advanceTimersByTimeAsync(4999);
    expect(connectMock).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);

    expect(connectMock).toHaveBeenCalledTimes(2);
    expect(rabbit.isConnected()).toBe(true);
    expect(rabbit.getChannel()).toBe(second.channel);
    expect(listener).toHaveBeenCalledTimes(2);
    await rabbit.close();
  });

  it('con el broker caído start no lanza y reintenta cada 5 s', async () => {
    connectMock.mockRejectedValueOnce(new Error('ECONNREFUSED'));
    const conn = new FakeConnection();
    queueConnections(conn);
    const rabbit = new RabbitMqConnection(URI);

    await expect(rabbit.start()).resolves.toBeUndefined();
    expect(rabbit.isConnected()).toBe(false);

    await vi.advanceTimersByTimeAsync(5000);
    expect(rabbit.isConnected()).toBe(true);
    await rabbit.close();
  });

  it('reconecta si un listener falla al preparar el canal', async () => {
    const bad = new FakeConnection();
    const good = new FakeConnection();
    queueConnections(bad, good);
    const rabbit = new RabbitMqConnection(URI);
    rabbit.onConnect(
      vi
        .fn()
        .mockRejectedValueOnce(new Error('topología'))
        .mockResolvedValue(undefined),
    );

    await rabbit.start();
    expect(rabbit.isConnected()).toBe(false);
    expect(bad.close).toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(5000);
    expect(rabbit.isConnected()).toBe(true);
    expect(rabbit.getChannel()).toBe(good.channel);
    await rabbit.close();
  });

  it('el close de una conexión descartada no tumba la nueva', async () => {
    const bad = new FakeConnection();
    const good = new FakeConnection();
    queueConnections(bad, good);
    const rabbit = new RabbitMqConnection(URI);
    rabbit.onConnect(
      vi
        .fn()
        .mockRejectedValueOnce(new Error('topología'))
        .mockResolvedValue(undefined),
    );
    await rabbit.start();
    await vi.advanceTimersByTimeAsync(5000);

    bad.emit('close');

    expect(rabbit.isConnected()).toBe(true);
    await rabbit.close();
  });

  it('un error de conexión no queda sin manejar', async () => {
    const conn = new FakeConnection();
    queueConnections(conn);
    const rabbit = new RabbitMqConnection(URI);
    await rabbit.start();

    expect(() => conn.emit('error', new Error('boom'))).not.toThrow();
    await rabbit.close();
  });

  it('close detiene la reconexión', async () => {
    const conn = new FakeConnection();
    queueConnections(conn);
    const rabbit = new RabbitMqConnection(URI);
    await rabbit.start();

    await rabbit.close();
    await vi.advanceTimersByTimeAsync(20000);

    expect(rabbit.isConnected()).toBe(false);
    expect(connectMock).toHaveBeenCalledTimes(1);
  });

  it('no escribe la URI en los logs', async () => {
    const { Logger } = await import('@nestjs/common');
    const warn = vi
      .spyOn(Logger.prototype, 'warn')
      .mockImplementation(() => {});
    connectMock.mockRejectedValueOnce(new Error('ECONNREFUSED'));
    const rabbit = new RabbitMqConnection(URI);

    await rabbit.start();
    await rabbit.close();

    expect(JSON.stringify(warn.mock.calls)).not.toContain('secreto');
    warn.mockRestore();
  });
});

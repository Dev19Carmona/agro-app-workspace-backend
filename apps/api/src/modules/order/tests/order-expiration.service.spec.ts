import { Logger } from '@nestjs/common';
import { OrderExpirationService } from '../services/order-expiration.service.js';

const NOW = new Date('2026-11-08T12:00:00.000Z');
const BUYER = 'b1'.repeat(12);
const O1 = 'a1'.repeat(12);
const O2 = 'a2'.repeat(12);

/** Encadena `.select().limit().lean()` como lo hace Mongoose. */
const chain = <T>(value: T) => {
  const q: Record<string, unknown> = {
    select: () => q,
    limit: () => q,
    lean: () => Promise.resolve(value),
  };
  return q;
};

describe('OrderExpirationService', () => {
  const abortTransaction = vi.fn();
  const endSession = vi.fn();
  const connection = { startSession: vi.fn() };
  const orderModel = { find: vi.fn(), updateOne: vi.fn() };
  const outbox = { add: vi.fn() };
  let service: OrderExpirationService;

  /** Primer `find` = AWAITING_PAYMENT vencidos; segundo = PENDING viejos. */
  const candidatos = (awaiting: unknown[], pending: unknown[]) => {
    orderModel.find
      .mockReturnValueOnce(chain(awaiting))
      .mockReturnValueOnce(chain(pending));
  };
  const pedido = (_id: string) => ({ _id, buyerId: BUYER });

  beforeEach(() => {
    vi.resetAllMocks();
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
    vi.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
    connection.startSession.mockResolvedValue({
      id: 'sesion',
      endSession,
      abortTransaction,
      withTransaction: async (fn: () => Promise<unknown>) => fn(),
    });
    orderModel.updateOne.mockResolvedValue({ modifiedCount: 1 });
    outbox.add.mockResolvedValue('evento');
    service = new OrderExpirationService(
      connection as never,
      orderModel as never,
      outbox as never,
    );
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it('busca AWAITING_PAYMENT con expiresAt vencido y PENDING con más de 5 min', async () => {
    candidatos([], []);

    await service.expireOrders();

    expect(orderModel.find).toHaveBeenNthCalledWith(1, {
      status: 'AWAITING_PAYMENT',
      expiresAt: { $lte: NOW },
    });
    expect(orderModel.find).toHaveBeenNthCalledWith(2, {
      status: 'PENDING',
      createdAt: { $lte: new Date(NOW.getTime() - 5 * 60 * 1000) },
    });
  });

  it('cancela con EXPIRED un AWAITING_PAYMENT vencido y escribe order.cancelled', async () => {
    candidatos([pedido(O1)], []);

    await service.expireOrders();

    expect(orderModel.updateOne).toHaveBeenCalledWith(
      { _id: O1, status: 'AWAITING_PAYMENT', expiresAt: { $lte: NOW } },
      { $set: { status: 'CANCELLED', cancelReason: 'EXPIRED' } },
      { session: expect.objectContaining({ id: 'sesion' }) },
    );
    expect(outbox.add).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'sesion' }),
      'order.cancelled',
      O1,
      { orderId: O1, buyerId: BUYER, motivo: 'EXPIRED' },
    );
    expect(abortTransaction).not.toHaveBeenCalled();
    expect(endSession).toHaveBeenCalledTimes(1);
  });

  it('cancela con STOCK_TIMEOUT un PENDING de más de 5 min y escribe order.cancelled', async () => {
    candidatos([], [pedido(O2)]);
    const limite = new Date(NOW.getTime() - 5 * 60 * 1000);

    await service.expireOrders();

    expect(orderModel.updateOne).toHaveBeenCalledWith(
      { _id: O2, status: 'PENDING', createdAt: { $lte: limite } },
      { $set: { status: 'CANCELLED', cancelReason: 'STOCK_TIMEOUT' } },
      expect.anything(),
    );
    expect(outbox.add).toHaveBeenCalledWith(
      expect.anything(),
      'order.cancelled',
      O2,
      { orderId: O2, buyerId: BUYER, motivo: 'STOCK_TIMEOUT' },
    );
  });

  it('un pedido que pasó a CONFIRMED entre la lectura y la actualización no se cancela ni emite', async () => {
    candidatos([pedido(O1)], []);
    orderModel.updateOne.mockResolvedValue({ modifiedCount: 0 });

    await service.expireOrders();

    expect(outbox.add).not.toHaveBeenCalled();
    expect(abortTransaction).toHaveBeenCalledTimes(1);
    expect(endSession).toHaveBeenCalledTimes(1);
  });

  it('un PENDING reciente no se toca: no es candidato', async () => {
    candidatos([], []);

    await service.expireOrders();

    expect(orderModel.updateOne).not.toHaveBeenCalled();
    expect(outbox.add).not.toHaveBeenCalled();
  });

  it('cada pedido va en su propia transacción', async () => {
    candidatos([pedido(O1)], [pedido(O2)]);

    await service.expireOrders();

    expect(connection.startSession).toHaveBeenCalledTimes(2);
    expect(endSession).toHaveBeenCalledTimes(2);
    expect(outbox.add).toHaveBeenCalledTimes(2);
  });

  it('el fallo de un pedido no frena a los demás', async () => {
    candidatos([pedido(O1), pedido(O2)], []);
    orderModel.updateOne
      .mockRejectedValueOnce(new Error('boom'))
      .mockResolvedValueOnce({ modifiedCount: 1 });

    await service.expireOrders();

    expect(outbox.add).toHaveBeenCalledTimes(1);
    expect(outbox.add).toHaveBeenCalledWith(
      expect.anything(),
      'order.cancelled',
      O2,
      expect.anything(),
    );
    expect(endSession).toHaveBeenCalledTimes(2);
  });

  it('un ciclo no se solapa con el anterior', async () => {
    let release!: () => void;
    orderModel.find.mockReturnValueOnce({
      select: () => ({
        limit: () => ({
          lean: () => new Promise((resolve) => (release = () => resolve([]))),
        }),
      }),
    });

    const first = service.expireOrders();
    await service.expireOrders(); // sale sin consultar
    expect(orderModel.find).toHaveBeenCalledTimes(1);

    release();
    orderModel.find.mockReturnValueOnce(chain([]));
    await first;
    candidatos([], []);
    await service.expireOrders();
    expect(orderModel.find.mock.calls.length).toBeGreaterThan(1);
  });

  it('si la consulta falla (Mongo caído) no revienta y permite el siguiente ciclo', async () => {
    orderModel.find.mockImplementationOnce(() => {
      throw new Error('mongo caído');
    });

    await expect(service.expireOrders()).resolves.toBeUndefined();

    candidatos([], []);
    await service.expireOrders();
    expect(orderModel.find).toHaveBeenCalledTimes(3);
  });
});

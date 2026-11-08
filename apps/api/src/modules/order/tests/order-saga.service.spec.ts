import { Logger } from '@nestjs/common';
import {
  OrderSagaService,
  PAYMENT_WINDOW_MS,
} from '../services/order-saga.service.js';

const NOW = new Date('2026-11-08T12:00:00.000Z');
const ORDER_ID = 'a1'.repeat(12);
const BUYER = 'b1'.repeat(12);

const evento = <T extends string>(type: T, eventId = 'e-1') => ({
  eventId,
  type,
  occurredAt: NOW.toISOString(),
  correlationId: ORDER_ID,
  payload: { orderId: ORDER_ID, items: [], motivo: 'INSUFFICIENT_STOCK' },
});

/** Encadena `.select().session().lean()` como lo hace Mongoose. */
const chain = <T>(value: T) => {
  const q: Record<string, unknown> = {
    select: () => q,
    session: () => q,
    lean: () => Promise.resolve(value),
  };
  return q;
};

describe('OrderSagaService (stock.reserved y stock.rejected)', () => {
  const session = { id: 'sesion' };
  const endSession = vi.fn();
  const connection = { startSession: vi.fn() };
  const orderModel = { findById: vi.fn(), updateOne: vi.fn() };
  const processedModel = { exists: vi.fn(), create: vi.fn() };
  const outbox = { add: vi.fn() };
  let service: OrderSagaService;

  const pedido = (status: string) =>
    orderModel.findById.mockReturnValue(
      chain({ _id: ORDER_ID, buyerId: BUYER, total: 5000, status }),
    );

  beforeEach(() => {
    vi.resetAllMocks();
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
    vi.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    connection.startSession.mockResolvedValue({
      ...session,
      endSession,
      withTransaction: async (fn: () => Promise<unknown>) => fn(),
    });
    processedModel.exists.mockResolvedValue(null);
    processedModel.create.mockResolvedValue([]);
    orderModel.updateOne.mockResolvedValue({ modifiedCount: 1 });
    outbox.add.mockResolvedValue('evento');
    service = new OrderSagaService(
      connection as never,
      orderModel as never,
      processedModel as never,
      outbox as never,
    );
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  describe('stock.reserved', () => {
    it('pasa PENDING a AWAITING_PAYMENT con expiresAt 15 min después y marca procesado', async () => {
      pedido('PENDING');

      await service.handleStockReserved(evento('stock.reserved') as never);

      expect(orderModel.updateOne).toHaveBeenCalledWith(
        { _id: ORDER_ID, status: 'PENDING' },
        {
          $set: {
            status: 'AWAITING_PAYMENT',
            expiresAt: new Date(NOW.getTime() + PAYMENT_WINDOW_MS),
          },
        },
        { session: expect.objectContaining({ id: 'sesion' }) },
      );
      expect(PAYMENT_WINDOW_MS).toBe(15 * 60 * 1000);
      expect(outbox.add).not.toHaveBeenCalled();
      expect(processedModel.create).toHaveBeenCalledWith(
        [{ eventId: 'e-1', type: 'stock.reserved' }],
        { session: expect.objectContaining({ id: 'sesion' }) },
      );
      expect(endSession).toHaveBeenCalled();
    });

    it('sobre un pedido CANCELLED escribe order.cancelled con LATE_RESERVATION', async () => {
      pedido('CANCELLED');

      await service.handleStockReserved(evento('stock.reserved') as never);

      expect(orderModel.updateOne).not.toHaveBeenCalled();
      expect(outbox.add).toHaveBeenCalledWith(
        expect.objectContaining({ id: 'sesion' }),
        'order.cancelled',
        ORDER_ID,
        { orderId: ORDER_ID, buyerId: BUYER, motivo: 'LATE_RESERVATION' },
      );
      expect(processedModel.create).toHaveBeenCalled();
    });

    it.each(['AWAITING_PAYMENT', 'CONFIRMED'])(
      'sobre un pedido %s solo marca procesado',
      async (status) => {
        pedido(status);

        await service.handleStockReserved(evento('stock.reserved') as never);

        expect(orderModel.updateOne).not.toHaveBeenCalled();
        expect(outbox.add).not.toHaveBeenCalled();
        expect(processedModel.create).toHaveBeenCalled();
      },
    );
  });

  describe('stock.rejected', () => {
    it('pasa PENDING a CANCELLED (STOCK_REJECTED) y escribe order.cancelled', async () => {
      pedido('PENDING');

      await service.handleStockRejected(evento('stock.rejected') as never);

      expect(orderModel.updateOne).toHaveBeenCalledWith(
        { _id: ORDER_ID, status: 'PENDING' },
        { $set: { status: 'CANCELLED', cancelReason: 'STOCK_REJECTED' } },
        { session: expect.objectContaining({ id: 'sesion' }) },
      );
      expect(outbox.add).toHaveBeenCalledWith(
        expect.objectContaining({ id: 'sesion' }),
        'order.cancelled',
        ORDER_ID,
        { orderId: ORDER_ID, buyerId: BUYER, motivo: 'STOCK_REJECTED' },
      );
      expect(processedModel.create).toHaveBeenCalled();
    });

    it.each(['AWAITING_PAYMENT', 'CONFIRMED', 'CANCELLED'])(
      'sobre un pedido %s solo marca procesado',
      async (status) => {
        pedido(status);

        await service.handleStockRejected(evento('stock.rejected') as never);

        expect(orderModel.updateOne).not.toHaveBeenCalled();
        expect(outbox.add).not.toHaveBeenCalled();
        expect(processedModel.create).toHaveBeenCalled();
      },
    );

    it('si la actualización condicional no modifica nada (otro ganó) no escribe el outbox', async () => {
      pedido('PENDING');
      orderModel.updateOne.mockResolvedValue({ modifiedCount: 0 });

      await service.handleStockRejected(evento('stock.rejected') as never);

      expect(outbox.add).not.toHaveBeenCalled();
    });
  });

  describe('payment.approved', () => {
    const aprobado = (eventId = 'e-1') => ({
      ...evento('payment.approved', eventId),
      payload: { orderId: ORDER_ID, paymentId: 'p1', monto: 5000 },
    });

    it('pasa AWAITING_PAYMENT a CONFIRMED y escribe order.confirmed', async () => {
      pedido('AWAITING_PAYMENT');

      await service.handlePaymentApproved(aprobado() as never);

      expect(orderModel.updateOne).toHaveBeenCalledWith(
        { _id: ORDER_ID, status: 'AWAITING_PAYMENT' },
        { $set: { status: 'CONFIRMED' } },
        { session: expect.objectContaining({ id: 'sesion' }) },
      );
      expect(outbox.add).toHaveBeenCalledWith(
        expect.objectContaining({ id: 'sesion' }),
        'order.confirmed',
        ORDER_ID,
        { orderId: ORDER_ID, buyerId: BUYER, total: 5000 },
      );
      expect(processedModel.create).toHaveBeenCalledWith(
        [{ eventId: 'e-1', type: 'payment.approved' }],
        expect.anything(),
      );
    });

    it('confirma aunque expiresAt ya haya pasado: la condición no mira expiresAt', async () => {
      pedido('AWAITING_PAYMENT');

      await service.handlePaymentApproved(aprobado() as never);

      const [filter] = orderModel.updateOne.mock.calls[0];
      expect(filter).toEqual({ _id: ORDER_ID, status: 'AWAITING_PAYMENT' });
      expect(outbox.add).toHaveBeenCalled();
    });

    it.each(['PENDING', 'CANCELLED', 'CONFIRMED'])(
      'sobre un pedido %s no cambia nada, marca procesado y deja un warn',
      async (status) => {
        pedido(status);
        const warn = vi.spyOn(Logger.prototype, 'warn');

        await service.handlePaymentApproved(aprobado() as never);

        expect(orderModel.updateOne).not.toHaveBeenCalled();
        expect(outbox.add).not.toHaveBeenCalled();
        expect(processedModel.create).toHaveBeenCalled();
        expect(warn).toHaveBeenCalledWith(expect.stringContaining(ORDER_ID));
      },
    );

    it('si otro cambio ganó la carrera (0 modificados) no escribe el outbox', async () => {
      pedido('AWAITING_PAYMENT');
      orderModel.updateOne.mockResolvedValue({ modifiedCount: 0 });

      await service.handlePaymentApproved(aprobado() as never);

      expect(outbox.add).not.toHaveBeenCalled();
      expect(processedModel.create).toHaveBeenCalled();
    });

    it('un eventId repetido no vuelve a confirmar ni a escribir el outbox', async () => {
      processedModel.exists.mockResolvedValue({ _id: 'x' });
      pedido('AWAITING_PAYMENT');

      await service.handlePaymentApproved(aprobado() as never);

      expect(orderModel.updateOne).not.toHaveBeenCalled();
      expect(outbox.add).not.toHaveBeenCalled();
    });
  });

  describe('payment.declined', () => {
    it('no cambia el estado: solo marca procesado y deja un log', async () => {
      pedido('AWAITING_PAYMENT');
      const log = vi
        .spyOn(Logger.prototype, 'log')
        .mockImplementation(() => undefined);

      await service.handlePaymentDeclined({
        ...evento('payment.declined'),
        payload: { orderId: ORDER_ID, paymentId: 'p1', motivo: 'FONDOS' },
      } as never);

      expect(orderModel.updateOne).not.toHaveBeenCalled();
      expect(outbox.add).not.toHaveBeenCalled();
      expect(processedModel.create).toHaveBeenCalledWith(
        [{ eventId: 'e-1', type: 'payment.declined' }],
        expect.anything(),
      );
      expect(log).toHaveBeenCalled();
    });

    it('un eventId repetido no hace nada', async () => {
      processedModel.exists.mockResolvedValue({ _id: 'x' });

      await service.handlePaymentDeclined(evento('payment.declined') as never);

      expect(processedModel.create).not.toHaveBeenCalled();
    });
  });

  describe('stock.released', () => {
    it.each(['PENDING', 'AWAITING_PAYMENT', 'CONFIRMED', 'CANCELLED'])(
      'sobre un pedido %s solo marca procesado y no cambia estados',
      async (status) => {
        pedido(status);
        vi.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);

        await service.handleStockReleased(evento('stock.released') as never);

        expect(orderModel.updateOne).not.toHaveBeenCalled();
        expect(outbox.add).not.toHaveBeenCalled();
        expect(processedModel.create).toHaveBeenCalledWith(
          [{ eventId: 'e-1', type: 'stock.released' }],
          expect.anything(),
        );
      },
    );

    it('un eventId repetido no hace nada', async () => {
      processedModel.exists.mockResolvedValue({ _id: 'x' });

      await service.handleStockReleased(evento('stock.released') as never);

      expect(processedModel.create).not.toHaveBeenCalled();
    });
  });

  describe('idempotencia y casos límite', () => {
    it.each([
      ['stock.reserved', 'handleStockReserved'],
      ['stock.rejected', 'handleStockRejected'],
    ] as const)(
      'un eventId repetido en %s no repite la transición ni el outbox',
      async (type, handler) => {
        processedModel.exists.mockResolvedValue({ _id: 'x' });
        pedido('PENDING');

        await service[handler](evento(type) as never);

        expect(connection.startSession).not.toHaveBeenCalled();
        expect(orderModel.updateOne).not.toHaveBeenCalled();
        expect(outbox.add).not.toHaveBeenCalled();
        expect(processedModel.create).not.toHaveBeenCalled();
      },
    );

    it('si dos entregas del mismo evento chocan (11000 al marcar) lo ignora', async () => {
      pedido('PENDING');
      processedModel.create.mockRejectedValue({ code: 11000 });

      await expect(
        service.handleStockReserved(evento('stock.reserved') as never),
      ).resolves.toBeUndefined();
      expect(endSession).toHaveBeenCalled();
    });

    it('un pedido inexistente solo se marca procesado', async () => {
      orderModel.findById.mockReturnValue(chain(null));

      await service.handleStockReserved(evento('stock.reserved') as never);

      expect(orderModel.updateOne).not.toHaveBeenCalled();
      expect(outbox.add).not.toHaveBeenCalled();
      expect(processedModel.create).toHaveBeenCalled();
    });

    it('un orderId que no es ObjectId no consulta Mongo y solo se marca procesado', async () => {
      const malo = evento('stock.reserved');
      malo.payload.orderId = '{"$ne": null}';

      await service.handleStockReserved(malo as never);

      expect(orderModel.findById).not.toHaveBeenCalled();
      expect(processedModel.create).toHaveBeenCalled();
    });

    it('propaga errores distintos de clave duplicada y cierra la sesión', async () => {
      pedido('PENDING');
      orderModel.updateOne.mockRejectedValue(new Error('boom'));

      await expect(
        service.handleStockReserved(evento('stock.reserved') as never),
      ).rejects.toThrow('boom');
      expect(endSession).toHaveBeenCalled();
    });
  });
});

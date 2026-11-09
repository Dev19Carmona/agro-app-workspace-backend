import { Logger } from '@nestjs/common';
import { Types } from 'mongoose';
import {
  PaymentEventsService,
  type EmittablePayment,
} from '../services/payment-events.service.js';

const FINALIZED = new Date('2026-11-08T12:00:00.000Z');
const orderId = new Types.ObjectId();
const paymentId = new Types.ObjectId();
const buyerId = new Types.ObjectId();

const pago = (extra: Partial<EmittablePayment> = {}): EmittablePayment => ({
  _id: paymentId,
  orderId,
  buyerId,
  monto: 50000,
  status: 'APPROVED',
  eventId: '3f2b8c1e-6a4d-4f0a-9b7e-1c2d3e4f5a6b',
  finalizedAt: FINALIZED,
  ...extra,
});

describe('PaymentEventsService', () => {
  const paymentModel = {
    updateOne: vi.fn(),
    find: vi.fn(),
    findOneAndUpdate: vi.fn(),
  };
  const events = { emitAsync: vi.fn() };
  let service: PaymentEventsService;
  let logError: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    vi.resetAllMocks();
    paymentModel.updateOne.mockResolvedValue({});
    events.emitAsync.mockResolvedValue([]);
    logError = vi.spyOn(Logger.prototype, 'error').mockImplementation(() => {});
    service = new PaymentEventsService(paymentModel as never, events as never);
  });

  it('APPROVED emite payment.approved con el sobre y el payload del spec 07', async () => {
    await expect(service.emit(pago())).resolves.toBe(true);
    expect(events.emitAsync).toHaveBeenCalledWith('payment.approved', {
      eventId: '3f2b8c1e-6a4d-4f0a-9b7e-1c2d3e4f5a6b',
      type: 'payment.approved',
      occurredAt: FINALIZED.toISOString(),
      correlationId: String(orderId),
      payload: {
        orderId: String(orderId),
        paymentId: String(paymentId),
        buyerId: String(buyerId),
        monto: 50000,
      },
    });
  });

  it('DECLINED emite payment.declined con motivo = motivoRechazo', async () => {
    await service.emit(
      pago({ status: 'DECLINED', motivoRechazo: 'INSUFFICIENT_FUNDS' }),
    );
    expect(events.emitAsync).toHaveBeenCalledWith(
      'payment.declined',
      expect.objectContaining({
        type: 'payment.declined',
        correlationId: String(orderId),
        payload: {
          orderId: String(orderId),
          paymentId: String(paymentId),
          buyerId: String(buyerId),
          motivo: 'INSUFFICIENT_FUNDS',
        },
      }),
    );
  });

  it('ERROR también emite payment.declined', async () => {
    await service.emit(
      pago({ status: 'ERROR', motivoRechazo: 'GATEWAY_ERROR' }),
    );
    expect(events.emitAsync).toHaveBeenCalledWith(
      'payment.declined',
      expect.objectContaining({
        payload: expect.objectContaining({ motivo: 'GATEWAY_ERROR' }),
      }),
    );
  });

  it('un rechazo sin motivo (webhook) usa UNKNOWN', async () => {
    await service.emit(pago({ status: 'DECLINED' }));
    expect(events.emitAsync).toHaveBeenCalledWith(
      'payment.declined',
      expect.objectContaining({
        payload: expect.objectContaining({ motivo: 'UNKNOWN' }),
      }),
    );
  });

  it('tras emitir marca eventEmittedAt', async () => {
    await service.emit(pago());
    expect(paymentModel.updateOne).toHaveBeenCalledWith(
      { _id: paymentId },
      { $set: { eventEmittedAt: expect.any(Date) } },
    );
  });

  it('si la emisión falla no marca, no lanza y devuelve false', async () => {
    events.emitAsync.mockRejectedValue(new Error('listener roto'));
    await expect(service.emit(pago())).resolves.toBe(false);
    expect(paymentModel.updateOne).not.toHaveBeenCalled();
  });

  it('el log de error no incluye el payload ni el monto', async () => {
    events.emitAsync.mockRejectedValue(new Error('listener roto'));
    await service.emit(pago());
    const mensaje = String(logError.mock.calls[0]?.[0]);
    expect(mensaje).toContain(String(paymentId));
    expect(mensaje).toContain('payment.approved');
    expect(mensaje).not.toContain('50000');
  });

  it('si falla marcar tras emitir, no lanza y devuelve false', async () => {
    paymentModel.updateOne.mockRejectedValue(new Error('mongo caído'));
    await expect(service.emit(pago())).resolves.toBe(false);
  });

  it.each(['PENDING', 'PROCESSING'])(
    'un pago %s no emite nada',
    async (status) => {
      await expect(service.emit(pago({ status }))).resolves.toBe(false);
      expect(events.emitAsync).not.toHaveBeenCalled();
      expect(paymentModel.updateOne).not.toHaveBeenCalled();
    },
  );

  it('un pago sin eventId no emite nada', async () => {
    await expect(service.emit(pago({ eventId: undefined }))).resolves.toBe(
      false,
    );
    expect(events.emitAsync).not.toHaveBeenCalled();
  });

  describe('reemit', () => {
    const NOW = new Date('2026-11-08T12:00:00.000Z');

    /** Encadena `.sort().limit().lean()` como lo hace Mongoose. */
    const finder = <T>(value: T) => {
      const q: Record<string, unknown> = {};
      q.sort = () => q;
      q.limit = () => q;
      q.lean = () => Promise.resolve(value);
      return q;
    };
    const leanOf = <T>(value: T) => ({ lean: () => Promise.resolve(value) });

    beforeEach(() => {
      vi.useFakeTimers();
      vi.setSystemTime(NOW);
      paymentModel.find.mockReturnValue(finder([pago()]));
      paymentModel.findOneAndUpdate.mockReturnValue(leanOf(pago()));
    });
    afterEach(() => vi.useRealTimers());

    it('busca pagos finales sin marca, con finalizedAt de hace más de 10 s y menos de 5 intentos', async () => {
      await service.reemit();
      expect(paymentModel.find).toHaveBeenCalledWith({
        status: { $in: ['APPROVED', 'DECLINED', 'ERROR'] },
        eventEmittedAt: { $exists: false },
        finalizedAt: { $lt: new Date(NOW.getTime() - 10_000) },
        eventAttempts: { $lt: 5 },
      });
    });

    it('reemite con el mismo eventId y suma el intento antes de emitir', async () => {
      await service.reemit();
      expect(paymentModel.findOneAndUpdate).toHaveBeenCalledWith(
        {
          _id: paymentId,
          eventEmittedAt: { $exists: false },
          eventAttempts: { $lt: 5 },
        },
        { $inc: { eventAttempts: 1 } },
        { returnDocument: 'after' },
      );
      expect(events.emitAsync).toHaveBeenCalledWith(
        'payment.approved',
        expect.objectContaining({
          eventId: '3f2b8c1e-6a4d-4f0a-9b7e-1c2d3e4f5a6b',
        }),
      );
      expect(
        paymentModel.findOneAndUpdate.mock.invocationCallOrder[0],
      ).toBeLessThan(events.emitAsync.mock.invocationCallOrder[0]);
    });

    it('al tener éxito marca eventEmittedAt, así deja de reemitirse', async () => {
      await service.reemit();
      expect(paymentModel.updateOne).toHaveBeenCalledWith(
        { _id: paymentId },
        { $set: { eventEmittedAt: expect.any(Date) } },
      );
    });

    it('si la reemisión falla no marca ni lanza; el intento ya quedó contado', async () => {
      events.emitAsync.mockRejectedValue(new Error('listener roto'));
      await expect(service.reemit()).resolves.toBeUndefined();
      expect(paymentModel.updateOne).not.toHaveBeenCalled();
      expect(paymentModel.findOneAndUpdate).toHaveBeenCalledTimes(1);
    });

    it('al llegar al tope el reclamo no devuelve nada y no emite', async () => {
      paymentModel.findOneAndUpdate.mockReturnValue(leanOf(null));
      await service.reemit();
      expect(events.emitAsync).not.toHaveBeenCalled();
    });

    it('sin pagos pendientes no hace nada', async () => {
      paymentModel.find.mockReturnValue(finder([]));
      await service.reemit();
      expect(paymentModel.findOneAndUpdate).not.toHaveBeenCalled();
      expect(events.emitAsync).not.toHaveBeenCalled();
    });

    it('reemite cada pago pendiente', async () => {
      const otro = pago({
        _id: new Types.ObjectId(),
        status: 'DECLINED',
        motivoRechazo: 'X',
      });
      paymentModel.find.mockReturnValue(finder([pago(), otro]));
      paymentModel.findOneAndUpdate
        .mockReturnValueOnce(leanOf(pago()))
        .mockReturnValueOnce(leanOf(otro));
      await service.reemit();
      expect(events.emitAsync).toHaveBeenCalledTimes(2);
      expect(events.emitAsync).toHaveBeenLastCalledWith(
        'payment.declined',
        expect.anything(),
      );
    });

    it('un fallo de Mongo en el ciclo se registra y no lanza', async () => {
      paymentModel.find.mockImplementation(() => {
        throw new Error('mongo caído');
      });
      await expect(service.reemit()).resolves.toBeUndefined();
      expect(logError).toHaveBeenCalled();
    });

    it('un ciclo no se solapa con el anterior', async () => {
      let liberar!: () => void;
      paymentModel.find.mockReturnValue(
        finder(new Promise<never[]>((r) => (liberar = () => r([])))),
      );
      const primero = service.reemit();
      await service.reemit();
      expect(paymentModel.find).toHaveBeenCalledTimes(1);
      liberar();
      await primero;
    });
  });
});

import {
  ConflictException,
  Logger,
  NotFoundException,
  UnprocessableEntityException,
} from '@nestjs/common';
import { Types } from 'mongoose';
import { computeRequestHash } from '../policies/request-hash.policy.js';
import { PaymentsService } from '../services/payments.service.js';

const NOW = new Date('2026-11-08T12:00:00.000Z');
const buyerId = new Types.ObjectId().toString();
const orderId = new Types.ObjectId().toString();
const KEY = 'clave-idempotente-1';
const dto = { orderId, metodo: 'CARD' as const, token: 'tok_test_approved' };
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

const pedido = (extra: Record<string, unknown> = {}) => ({
  orderId,
  buyerId,
  total: 75000,
  moneda: 'COP' as const,
  status: 'AWAITING_PAYMENT',
  expiresAt: new Date(NOW.getTime() + 60_000),
  ...extra,
});

const guardado = (extra: Record<string, unknown> = {}) => ({
  _id: new Types.ObjectId(),
  orderId,
  buyerId,
  monto: 75000,
  moneda: 'COP',
  metodo: 'CARD',
  status: 'PENDING',
  requestHash: computeRequestHash(dto),
  ...extra,
});

/** Encadena `.lean().exec()` como lo hace Mongoose. */
const lean = <T>(value: T) => ({
  lean: () => ({ exec: () => Promise.resolve(value) }),
});

describe('PaymentsService.create', () => {
  const paymentModel = {
    findOne: vi.fn(),
    findById: vi.fn(),
    findOneAndUpdate: vi.fn(),
    updateOne: vi.fn(),
    create: vi.fn(),
  };
  const attemptModel = { create: vi.fn() };
  const orderQuery = { getOrderForPayment: vi.fn() };
  const gateway = { charge: vi.fn() };
  const events = { emit: vi.fn() };
  const session = { withTransaction: vi.fn(), endSession: vi.fn() };
  const connection = { startSession: vi.fn() };
  let service: PaymentsService;
  let logError: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    vi.resetAllMocks();
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
    logError = vi.spyOn(Logger.prototype, 'error').mockImplementation(() => {});
    paymentModel.findOne.mockReturnValue(lean(null));
    orderQuery.getOrderForPayment.mockResolvedValue(pedido());
    paymentModel.create.mockImplementation(async (datos: object) => ({
      toObject: () => guardado(datos as Record<string, unknown>),
    }));
    // `PENDING` → `PROCESSING`: devuelve el pago con el estado nuevo.
    paymentModel.findOneAndUpdate.mockImplementation(() =>
      lean(guardado({ status: 'PROCESSING', monto: 75000 })),
    );
    paymentModel.updateOne.mockResolvedValue({ modifiedCount: 1 });
    attemptModel.create.mockResolvedValue([]);
    gateway.charge.mockResolvedValue({
      resultado: 'APPROVED',
      referencia: 'SIM-1',
    });
    events.emit.mockResolvedValue(true);
    session.withTransaction.mockImplementation(
      async (fn: () => Promise<void>) => fn(),
    );
    session.endSession.mockResolvedValue(undefined);
    connection.startSession.mockResolvedValue(session);
    service = new PaymentsService(
      connection as never,
      paymentModel as never,
      attemptModel as never,
      orderQuery as never,
      gateway as never,
      events as never,
    );
  });
  afterEach(() => vi.useRealTimers());

  describe('alta', () => {
    it('inserta un Payment PENDING con el monto de order, nunca del cliente', async () => {
      await service.create(buyerId, KEY, dto);
      expect(orderQuery.getOrderForPayment).toHaveBeenCalledWith(orderId, buyerId);
      expect(paymentModel.create).toHaveBeenCalledWith({
        orderId,
        buyerId,
        monto: 75000,
        moneda: 'COP',
        metodo: 'CARD',
        idempotencyKey: KEY,
        requestHash: computeRequestHash(dto),
      });
    });

    it('guarda el hash pero nunca el token', async () => {
      await service.create(buyerId, KEY, dto);
      const guardados = JSON.stringify([
        paymentModel.create.mock.calls,
        paymentModel.updateOne.mock.calls,
        attemptModel.create.mock.calls,
      ]);
      expect(guardados).not.toContain('tok_test');
    });
  });

  describe('idempotencia', () => {
    it('misma clave y mismo cuerpo: devuelve el mismo pago sin cobrar', async () => {
      const previo = guardado({ status: 'APPROVED' });
      paymentModel.findOne.mockReturnValue(lean(previo));
      const r = await service.create(buyerId, KEY, dto);
      expect(r).toEqual({ payment: previo, replay: true });
      expect(paymentModel.findOne).toHaveBeenCalledWith({
        buyerId,
        idempotencyKey: KEY,
      });
      expect(orderQuery.getOrderForPayment).not.toHaveBeenCalled();
      expect(paymentModel.create).not.toHaveBeenCalled();
      expect(gateway.charge).not.toHaveBeenCalled();
      expect(attemptModel.create).not.toHaveBeenCalled();
      expect(events.emit).not.toHaveBeenCalled();
    });

    it('el replay funciona aunque el pedido ya no sea pagable', async () => {
      paymentModel.findOne.mockReturnValue(lean(guardado({ status: 'APPROVED' })));
      orderQuery.getOrderForPayment.mockResolvedValue(pedido({ status: 'CONFIRMED' }));
      await expect(service.create(buyerId, KEY, dto)).resolves.toMatchObject({
        replay: true,
      });
    });

    it('un reintento mientras el original está en la pasarela devuelve PROCESSING', async () => {
      paymentModel.findOne.mockReturnValue(lean(guardado({ status: 'PROCESSING' })));
      const r = await service.create(buyerId, KEY, dto);
      expect(r.payment.status).toBe('PROCESSING');
      expect(gateway.charge).not.toHaveBeenCalled();
    });

    it.each([
      ['otro orderId', { orderId: new Types.ObjectId().toString() }],
      ['otro metodo', { metodo: 'PSE' as const }],
      ['otro token', { token: 'tok_test_declined' }],
    ])('misma clave con %s: 422', async (_n, cambio) => {
      paymentModel.findOne.mockReturnValue(lean(guardado()));
      await expect(
        service.create(buyerId, KEY, { ...dto, ...cambio }),
      ).rejects.toBeInstanceOf(UnprocessableEntityException);
      expect(paymentModel.create).not.toHaveBeenCalled();
      expect(gateway.charge).not.toHaveBeenCalled();
    });
  });

  describe('validación del pedido', () => {
    it('pedido inexistente o ajeno: 404', async () => {
      orderQuery.getOrderForPayment.mockResolvedValue(null);
      await expect(service.create(buyerId, KEY, dto)).rejects.toBeInstanceOf(
        NotFoundException,
      );
      expect(paymentModel.create).not.toHaveBeenCalled();
    });

    it.each(['PENDING', 'CONFIRMED', 'CANCELLED'])(
      'pedido %s: 409 ORDER_NOT_PAYABLE',
      async (status) => {
        orderQuery.getOrderForPayment.mockResolvedValue(pedido({ status }));
        const error = await service.create(buyerId, KEY, dto).catch((e) => e);
        expect(error).toBeInstanceOf(ConflictException);
        expect(error.getResponse()).toMatchObject({ code: 'ORDER_NOT_PAYABLE' });
        expect(paymentModel.create).not.toHaveBeenCalled();
        expect(gateway.charge).not.toHaveBeenCalled();
      },
    );

    it('AWAITING_PAYMENT con expiresAt pasado: 409 ORDER_NOT_PAYABLE', async () => {
      orderQuery.getOrderForPayment.mockResolvedValue(
        pedido({ expiresAt: new Date(NOW.getTime() - 1) }),
      );
      const error = await service.create(buyerId, KEY, dto).catch((e) => e);
      expect(error).toBeInstanceOf(ConflictException);
      expect(error.getResponse()).toMatchObject({ code: 'ORDER_NOT_PAYABLE' });
    });

    it('expiresAt exactamente ahora ya está vencido', async () => {
      orderQuery.getOrderForPayment.mockResolvedValue(pedido({ expiresAt: NOW }));
      await expect(service.create(buyerId, KEY, dto)).rejects.toBeInstanceOf(
        ConflictException,
      );
    });
  });

  describe('conflicto de índice (11000)', () => {
    const duplicado = Object.assign(new Error('E11000'), { code: 11000 });

    it('doble clic simultáneo: relee la clave y devuelve ese pago sin cobrar', async () => {
      const ganador = guardado();
      paymentModel.findOne
        .mockReturnValueOnce(lean(null))
        .mockReturnValueOnce(lean(ganador));
      paymentModel.create.mockRejectedValue(duplicado);
      await expect(service.create(buyerId, KEY, dto)).resolves.toEqual({
        payment: ganador,
        replay: true,
      });
      expect(gateway.charge).not.toHaveBeenCalled();
    });

    it('doble clic con cuerpo distinto: 422', async () => {
      paymentModel.findOne
        .mockReturnValueOnce(lean(null))
        .mockReturnValueOnce(lean(guardado({ requestHash: 'otro' })));
      paymentModel.create.mockRejectedValue(duplicado);
      await expect(service.create(buyerId, KEY, dto)).rejects.toBeInstanceOf(
        UnprocessableEntityException,
      );
    });

    it('sin la clave: es el índice parcial, 409 PAYMENT_IN_PROGRESS', async () => {
      paymentModel.create.mockRejectedValue(duplicado);
      const error = await service.create(buyerId, 'otra-clave-1', dto).catch((e) => e);
      expect(error).toBeInstanceOf(ConflictException);
      expect(error.getResponse()).toMatchObject({ code: 'PAYMENT_IN_PROGRESS' });
      expect(gateway.charge).not.toHaveBeenCalled();
    });

    it('otros errores de Mongo se propagan', async () => {
      const roto = new Error('mongo caído');
      paymentModel.create.mockRejectedValue(roto);
      await expect(service.create(buyerId, KEY, dto)).rejects.toBe(roto);
    });
  });

  describe('cobro y cierre', () => {
    it('pasa a PROCESSING con una actualización condicional a PENDING antes de cobrar', async () => {
      await service.create(buyerId, KEY, dto);
      expect(paymentModel.findOneAndUpdate).toHaveBeenCalledWith(
        { _id: expect.anything(), status: 'PENDING' },
        { $set: { status: 'PROCESSING' } },
        { returnDocument: 'after' },
      );
      expect(
        paymentModel.findOneAndUpdate.mock.invocationCallOrder[0],
      ).toBeLessThan(gateway.charge.mock.invocationCallOrder[0]);
    });

    it('cobra el monto de order (no del cliente) con el token del cuerpo', async () => {
      await service.create(buyerId, KEY, dto);
      expect(gateway.charge).toHaveBeenCalledWith({
        monto: 75000,
        moneda: 'COP',
        metodo: 'CARD',
        token: 'tok_test_approved',
      });
    });

    it('APPROVED: estado final, intento y evento; responde 201 (replay false)', async () => {
      const r = await service.create(buyerId, KEY, dto);

      expect(r.replay).toBe(false);
      expect(r.payment).toMatchObject({
        status: 'APPROVED',
        referencia: 'SIM-1',
        monto: 75000,
      });
      expect(r.payment.eventId).toMatch(UUID);
      expect(r.payment.finalizedAt).toEqual(NOW);
      expect(paymentModel.updateOne).toHaveBeenCalledWith(
        { _id: expect.anything(), status: 'PROCESSING' },
        {
          $set: {
            status: 'APPROVED',
            eventId: expect.stringMatching(UUID),
            finalizedAt: NOW,
            referencia: 'SIM-1',
          },
        },
        { session },
      );
      expect(attemptModel.create).toHaveBeenCalledWith(
        [
          {
            paymentId: expect.anything(),
            orderId,
            buyerId,
            origen: 'SIMULATOR',
            resultado: 'APPROVED',
          },
        ],
        { session },
      );
      expect(events.emit).toHaveBeenCalledWith(r.payment);
    });

    it.each([
      ['DECLINED', 'INSUFFICIENT_FUNDS'],
      ['ERROR', 'GATEWAY_ERROR'],
      ['DECLINED', 'INVALID_TOKEN'],
    ])('%s con motivo %s queda final y emite', async (resultado, motivo) => {
      gateway.charge.mockResolvedValue({ resultado, referencia: 'SIM-2', motivo });
      const r = await service.create(buyerId, KEY, dto);

      expect(r.payment).toMatchObject({ status: resultado, motivoRechazo: motivo });
      expect(attemptModel.create.mock.calls[0]?.[0][0]).toMatchObject({
        resultado,
        motivo,
      });
      expect(events.emit).toHaveBeenCalledTimes(1);
    });

    it('PROCESSING (tok_test_pending): sigue PROCESSING, solo el intento, sin evento', async () => {
      gateway.charge.mockResolvedValue({ resultado: 'PROCESSING', referencia: 'SIM-3' });
      const r = await service.create(buyerId, KEY, dto);

      expect(r.payment.status).toBe('PROCESSING');
      expect(r.payment.eventId).toBeUndefined();
      expect(paymentModel.updateOne).not.toHaveBeenCalled();
      expect(attemptModel.create).toHaveBeenCalledWith(
        [expect.objectContaining({ resultado: 'PROCESSING', origen: 'SIMULATOR' })],
        { session },
      );
      expect(events.emit).not.toHaveBeenCalled();
    });

    it('una excepción de la pasarela deja el pago en ERROR con GATEWAY_ERROR', async () => {
      gateway.charge.mockRejectedValue(new Error('timeout'));
      const r = await service.create(buyerId, KEY, dto);

      expect(r.payment).toMatchObject({
        status: 'ERROR',
        motivoRechazo: 'GATEWAY_ERROR',
      });
      expect(r.payment.referencia).toBeUndefined();
      expect(attemptModel.create.mock.calls[0]?.[0][0]).toMatchObject({
        resultado: 'ERROR',
        motivo: 'GATEWAY_ERROR',
      });
      expect(events.emit).toHaveBeenCalledTimes(1);
    });

    it('el log de un fallo de la pasarela no incluye el token', async () => {
      gateway.charge.mockRejectedValue(new Error('timeout'));
      await service.create(buyerId, KEY, dto);
      const log = logError.mock.calls[0]?.[0];
      expect(String(log)).not.toContain('tok_test');
    });

    it('estado final y PaymentAttempt van en la misma transacción', async () => {
      await service.create(buyerId, KEY, dto);
      expect(connection.startSession).toHaveBeenCalledTimes(1);
      expect(session.withTransaction).toHaveBeenCalledTimes(1);
      expect(session.endSession).toHaveBeenCalledTimes(1);
      expect(paymentModel.updateOne.mock.calls[0]?.[2]).toEqual({ session });
      expect(attemptModel.create.mock.calls[0]?.[1]).toEqual({ session });
    });

    it('si el insert del intento falla, no se emite el evento y el error se propaga', async () => {
      attemptModel.create.mockRejectedValue(new Error('mongo caído'));
      await expect(service.create(buyerId, KEY, dto)).rejects.toThrow('mongo caído');
      expect(events.emit).not.toHaveBeenCalled();
      expect(session.endSession).toHaveBeenCalledTimes(1);
    });

    it('si el webhook ya lo resolvió: no inserta intento, no emite y devuelve el pago actual', async () => {
      const actual = guardado({ status: 'APPROVED' });
      paymentModel.updateOne.mockResolvedValue({ modifiedCount: 0 });
      paymentModel.findById.mockReturnValue(lean(actual));

      const r = await service.create(buyerId, KEY, dto);

      expect(r.payment).toBe(actual);
      expect(attemptModel.create).not.toHaveBeenCalled();
      expect(events.emit).not.toHaveBeenCalled();
    });

    it('si ya no estaba PENDING, no cobra y devuelve el pago actual', async () => {
      const actual = guardado({ status: 'PROCESSING' });
      paymentModel.findOneAndUpdate.mockReturnValue(lean(null));
      paymentModel.findById.mockReturnValue(lean(actual));

      const r = await service.create(buyerId, KEY, dto);

      expect(r.payment).toBe(actual);
      expect(gateway.charge).not.toHaveBeenCalled();
    });

    it('un fallo de emisión no falla la petición', async () => {
      events.emit.mockResolvedValue(false);
      await expect(service.create(buyerId, KEY, dto)).resolves.toMatchObject({
        replay: false,
      });
    });
  });
});

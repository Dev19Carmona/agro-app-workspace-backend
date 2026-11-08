import { NotFoundException, UnauthorizedException } from '@nestjs/common';
import { Types } from 'mongoose';
import { computeWebhookSignature } from '../policies/webhook-signature.policy.js';
import { WebhookService } from '../services/webhook.service.js';

const NOW = new Date('2026-11-08T12:00:00.000Z');
const SECRET = 's'.repeat(32);
const ts = String(Math.floor(NOW.getTime() / 1000));
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

const paymentId = new Types.ObjectId();
const orderId = new Types.ObjectId();
const buyerId = new Types.ObjectId();
const dto = {
  eventId: '3f2b8c1e-6a4d-4f0a-9b7e-1c2d3e4f5a6b',
  paymentId: paymentId.toString(),
  resultado: 'APPROVED' as const,
};

/** Encadena `.session().select().lean()` como lo hace Mongoose. */
const chain = <T>(value: T) => {
  const q: Record<string, unknown> = {};
  q.session = () => q;
  q.select = () => q;
  q.lean = () => Promise.resolve(value);
  return q;
};

describe('WebhookService', () => {
  const config = { get: vi.fn() };
  const paymentModel = { findById: vi.fn(), findOneAndUpdate: vi.fn() };
  const attemptModel = { create: vi.fn() };
  const processedModel = { create: vi.fn() };
  const events = { emit: vi.fn() };
  const session = { withTransaction: vi.fn(), endSession: vi.fn() };
  const connection = { startSession: vi.fn() };
  let service: WebhookService;

  const actualizado = (extra: Record<string, unknown> = {}) => ({
    _id: paymentId,
    orderId,
    buyerId,
    monto: 75000,
    status: 'APPROVED',
    eventId: 'ev-pago',
    ...extra,
  });

  beforeEach(() => {
    vi.resetAllMocks();
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
    config.get.mockReturnValue(SECRET);
    processedModel.create.mockResolvedValue([]);
    paymentModel.findById.mockReturnValue(chain({ _id: paymentId }));
    paymentModel.findOneAndUpdate.mockReturnValue(chain(actualizado()));
    attemptModel.create.mockResolvedValue([]);
    events.emit.mockResolvedValue(true);
    session.withTransaction.mockImplementation(
      async (fn: () => Promise<void>) => fn(),
    );
    session.endSession.mockResolvedValue(undefined);
    connection.startSession.mockResolvedValue(session);
    service = new WebhookService(
      config as never,
      connection as never,
      paymentModel as never,
      attemptModel as never,
      processedModel as never,
      events as never,
    );
  });
  afterEach(() => vi.useRealTimers());

  describe('verifySignature', () => {
    const body = Buffer.from(JSON.stringify(dto));
    const firma = (t = ts) => computeWebhookSignature(SECRET, t, body);

    it('acepta una firma válida y vigente', () => {
      expect(() => service.verifySignature(body, ts, firma())).not.toThrow();
    });

    it.each([
      ['firma alterada', () => [body, ts, 'a'.repeat(64)] as const],
      ['firma ausente', () => [body, ts, undefined] as const],
      ['timestamp ausente', () => [body, undefined, firma()] as const],
      [
        'timestamp a más de 300 s',
        () => {
          const viejo = String(Number(ts) - 301);
          return [body, viejo, firma(viejo)] as const;
        },
      ],
      ['cuerpo distinto', () => [Buffer.from('{}'), ts, firma()] as const],
      ['sin cuerpo crudo', () => [undefined, ts, firma()] as const],
    ])('401 con %s', (_n, args) => {
      expect(() => service.verifySignature(...args())).toThrow(
        UnauthorizedException,
      );
    });

    it('todos los 401 llevan el mismo mensaje genérico', () => {
      const mensajes = [
        () => service.verifySignature(body, undefined, undefined),
        () => service.verifySignature(body, ts, 'a'.repeat(64)),
        () => service.verifySignature(body, 'x', firma()),
      ].map((f) => {
        try {
          f();
        } catch (e) {
          return (e as UnauthorizedException).message;
        }
      });
      expect(new Set(mensajes).size).toBe(1);
    });

    it('no toca Mongo', () => {
      expect(() => service.verifySignature(body, ts, 'a'.repeat(64))).toThrow();
      expect(connection.startSession).not.toHaveBeenCalled();
    });
  });

  describe('resolve', () => {
    it('inserta el eventId, resuelve el pago, registra el intento WEBHOOK y emite', async () => {
      await service.resolve(dto);

      expect(processedModel.create).toHaveBeenCalledWith(
        [{ eventId: dto.eventId }],
        { session },
      );
      expect(paymentModel.findOneAndUpdate).toHaveBeenCalledWith(
        { _id: paymentId, status: 'PROCESSING' },
        {
          $set: {
            status: 'APPROVED',
            eventId: expect.stringMatching(UUID),
            finalizedAt: NOW,
          },
        },
        { session, returnDocument: 'after' },
      );
      expect(attemptModel.create).toHaveBeenCalledWith(
        [
          {
            paymentId,
            orderId,
            buyerId,
            origen: 'WEBHOOK',
            resultado: 'APPROVED',
          },
        ],
        { session },
      );
      expect(events.emit).toHaveBeenCalledWith(actualizado());
      expect(session.endSession).toHaveBeenCalledTimes(1);
    });

    it('DECLINED guarda el motivo del webhook', async () => {
      await service.resolve({ ...dto, resultado: 'DECLINED', motivo: 'FRAUDE' });

      expect(paymentModel.findOneAndUpdate.mock.calls[0]?.[1]).toEqual({
        $set: expect.objectContaining({
          status: 'DECLINED',
          motivoRechazo: 'FRAUDE',
        }),
      });
      expect(attemptModel.create.mock.calls[0]?.[0][0]).toMatchObject({
        resultado: 'DECLINED',
        motivo: 'FRAUDE',
      });
    });

    it('ERROR puede llegar por webhook', async () => {
      await service.resolve({ ...dto, resultado: 'ERROR' });

      expect(paymentModel.findOneAndUpdate.mock.calls[0]?.[1]).toEqual({
        $set: expect.objectContaining({ status: 'ERROR' }),
      });
      expect(events.emit).toHaveBeenCalledTimes(1);
    });

    it('eventId repetido (11000): no cambia nada ni emite, y no falla', async () => {
      processedModel.create.mockRejectedValue(
        Object.assign(new Error('E11000'), { code: 11000 }),
      );

      await expect(service.resolve(dto)).resolves.toBeUndefined();

      expect(paymentModel.findById).not.toHaveBeenCalled();
      expect(paymentModel.findOneAndUpdate).not.toHaveBeenCalled();
      expect(attemptModel.create).not.toHaveBeenCalled();
      expect(events.emit).not.toHaveBeenCalled();
      expect(session.endSession).toHaveBeenCalledTimes(1);
    });

    it('pago inexistente: 404 y la transacción se aborta', async () => {
      paymentModel.findById.mockReturnValue(chain(null));

      await expect(service.resolve(dto)).rejects.toBeInstanceOf(
        NotFoundException,
      );
      expect(paymentModel.findOneAndUpdate).not.toHaveBeenCalled();
      expect(events.emit).not.toHaveBeenCalled();
    });

    it('pago ya resuelto: no inserta intento ni emite, y no falla', async () => {
      paymentModel.findOneAndUpdate.mockReturnValue(chain(null));

      await expect(service.resolve(dto)).resolves.toBeUndefined();

      expect(attemptModel.create).not.toHaveBeenCalled();
      expect(events.emit).not.toHaveBeenCalled();
    });

    it('no consulta el pedido: un pago tardío queda APPROVED y emite', async () => {
      // `WebhookService` no recibe ningún servicio de `order`.
      await service.resolve(dto);
      expect(events.emit).toHaveBeenCalledTimes(1);
    });

    it('un error inesperado de Mongo se propaga y cierra la sesión', async () => {
      attemptModel.create.mockRejectedValue(new Error('mongo caído'));

      await expect(service.resolve(dto)).rejects.toThrow('mongo caído');
      expect(events.emit).not.toHaveBeenCalled();
      expect(session.endSession).toHaveBeenCalledTimes(1);
    });
  });
});

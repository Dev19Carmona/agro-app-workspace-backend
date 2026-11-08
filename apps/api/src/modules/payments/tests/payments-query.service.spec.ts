import { NotFoundException } from '@nestjs/common';
import { Types } from 'mongoose';
import { PaymentsQueryService } from '../services/payments-query.service.js';

const BUYER = new Types.ObjectId().toString();
const OTRO = new Types.ObjectId().toString();
const ID = new Types.ObjectId();
const ORDER = new Types.ObjectId();
const CREATED = new Date('2026-11-08T12:00:00.000Z');

const pago = (extra: Record<string, unknown> = {}) => ({
  _id: ID,
  orderId: ORDER,
  buyerId: new Types.ObjectId(BUYER),
  monto: 75000,
  moneda: 'COP',
  metodo: 'CARD',
  status: 'APPROVED',
  referencia: 'SIM-1',
  idempotencyKey: 'clave-secreta-1',
  requestHash: 'hash-secreto',
  eventId: 'ev-1',
  eventAttempts: 0,
  createdAt: CREATED,
  updatedAt: CREATED,
  ...extra,
});

/** Encadena `.sort().skip().limit().lean()` como lo hace Mongoose. */
const chain = <T>(value: T) => {
  const q = {
    sort: vi.fn(() => q),
    skip: vi.fn(() => q),
    limit: vi.fn(() => q),
    lean: vi.fn(() => Promise.resolve(value)),
  };
  return q;
};

describe('PaymentsQueryService (PRODUCTOR)', () => {
  const paymentModel = {
    find: vi.fn(),
    findOne: vi.fn(),
    findById: vi.fn(),
    countDocuments: vi.fn(),
  };
  const attemptModel = { find: vi.fn() };
  let service: PaymentsQueryService;

  beforeEach(() => {
    vi.resetAllMocks();
    service = new PaymentsQueryService(
      paymentModel as never,
      attemptModel as never,
    );
  });

  describe('listMine', () => {
    it('lista solo los pagos del comprador, del más reciente al más antiguo', async () => {
      const q = chain([pago()]);
      paymentModel.find.mockReturnValue(q);
      paymentModel.countDocuments.mockResolvedValue(1);

      const page = await service.listMine(BUYER, { page: 1, limit: 20 });

      expect(paymentModel.find).toHaveBeenCalledWith({ buyerId: BUYER });
      expect(q.sort).toHaveBeenCalledWith({ createdAt: -1, _id: -1 });
      expect(page).toEqual({
        data: [
          {
            id: ID.toString(),
            orderId: ORDER.toString(),
            monto: 75000,
            moneda: 'COP',
            metodo: 'CARD',
            status: 'APPROVED',
            referencia: 'SIM-1',
            motivoRechazo: undefined,
            createdAt: CREATED,
          },
        ],
        page: 1,
        limit: 20,
        total: 1,
      });
    });

    it('pagina con skip y limit', async () => {
      const q = chain([]);
      paymentModel.find.mockReturnValue(q);
      paymentModel.countDocuments.mockResolvedValue(45);

      const page = await service.listMine(BUYER, { page: 3, limit: 10 });

      expect(q.skip).toHaveBeenCalledWith(20);
      expect(q.limit).toHaveBeenCalledWith(10);
      expect(page.total).toBe(45);
    });

    it('filtra por status y orderId, y cuenta con el mismo filtro', async () => {
      paymentModel.find.mockReturnValue(chain([]));
      paymentModel.countDocuments.mockResolvedValue(0);
      const orderId = ORDER.toString();

      await service.listMine(BUYER, {
        page: 1,
        limit: 20,
        status: 'DECLINED',
        orderId,
      });

      const filter = { buyerId: BUYER, status: 'DECLINED', orderId };
      expect(paymentModel.find).toHaveBeenCalledWith(filter);
      expect(paymentModel.countDocuments).toHaveBeenCalledWith(filter);
    });

    it('la respuesta no incluye idempotencyKey, requestHash ni eventId', async () => {
      paymentModel.find.mockReturnValue(chain([pago()]));
      paymentModel.countDocuments.mockResolvedValue(1);

      const page = await service.listMine(BUYER, { page: 1, limit: 20 });

      const texto = JSON.stringify(page);
      for (const prohibido of [
        'idempotencyKey',
        'requestHash',
        'clave-secreta-1',
        'hash-secreto',
        'eventId',
        'buyerId',
      ]) {
        expect(texto).not.toContain(prohibido);
      }
    });
  });

  describe('getMine', () => {
    it('devuelve el pago propio', async () => {
      paymentModel.findOne.mockReturnValue(chain(pago()));

      const view = await service.getMine(BUYER, ID.toString());

      expect(paymentModel.findOne).toHaveBeenCalledWith({
        _id: ID.toString(),
        buyerId: BUYER,
      });
      expect(view).toMatchObject({ id: ID.toString(), status: 'APPROVED' });
      expect(JSON.stringify(view)).not.toContain('idempotencyKey');
      expect(JSON.stringify(view)).not.toContain('requestHash');
    });

    it('pago ajeno o inexistente: 404', async () => {
      paymentModel.findOne.mockReturnValue(chain(null));

      await expect(
        service.getMine(OTRO, ID.toString()),
      ).rejects.toBeInstanceOf(NotFoundException);
      expect(paymentModel.findOne).toHaveBeenCalledWith({
        _id: ID.toString(),
        buyerId: OTRO,
      });
    });
  });

  describe('listAdmin', () => {
    it('lista todos los pagos sin filtrar por comprador, con buyerId en cada fila', async () => {
      const q = chain([pago()]);
      paymentModel.find.mockReturnValue(q);
      paymentModel.countDocuments.mockResolvedValue(1);

      const page = await service.listAdmin({ page: 1, limit: 20 });

      expect(paymentModel.find).toHaveBeenCalledWith({});
      expect(q.sort).toHaveBeenCalledWith({ createdAt: -1, _id: -1 });
      expect(page.data[0]).toMatchObject({
        id: ID.toString(),
        buyerId: BUYER,
        monto: 75000,
        status: 'APPROVED',
      });
      expect(page).toMatchObject({ page: 1, limit: 20, total: 1 });
    });

    it('filtra por status, buyerId y orderId, y cuenta con el mismo filtro', async () => {
      paymentModel.find.mockReturnValue(chain([]));
      paymentModel.countDocuments.mockResolvedValue(0);
      const orderId = ORDER.toString();

      await service.listAdmin({
        page: 1,
        limit: 20,
        status: 'ERROR',
        buyerId: BUYER,
        orderId,
      });

      const filter = { status: 'ERROR', buyerId: BUYER, orderId };
      expect(paymentModel.find).toHaveBeenCalledWith(filter);
      expect(paymentModel.countDocuments).toHaveBeenCalledWith(filter);
    });

    it('pagina con skip y limit', async () => {
      const q = chain([]);
      paymentModel.find.mockReturnValue(q);
      paymentModel.countDocuments.mockResolvedValue(150);

      await service.listAdmin({ page: 2, limit: 100 });

      expect(q.skip).toHaveBeenCalledWith(100);
      expect(q.limit).toHaveBeenCalledWith(100);
    });

    it('no expone idempotencyKey, requestHash ni eventId', async () => {
      paymentModel.find.mockReturnValue(chain([pago()]));
      paymentModel.countDocuments.mockResolvedValue(1);

      const texto = JSON.stringify(
        await service.listAdmin({ page: 1, limit: 20 }),
      );

      for (const prohibido of [
        'idempotencyKey',
        'requestHash',
        'clave-secreta-1',
        'hash-secreto',
        'eventId',
      ]) {
        expect(texto).not.toContain(prohibido);
      }
    });
  });

  describe('getAdmin', () => {
    const intento = (extra: Record<string, unknown> = {}) => ({
      _id: new Types.ObjectId(),
      paymentId: ID,
      orderId: ORDER,
      buyerId: new Types.ObjectId(BUYER),
      origen: 'SIMULATOR',
      resultado: 'PROCESSING',
      createdAt: CREATED,
      ...extra,
    });

    it('devuelve cualquier pago con sus intentos en orden cronológico', async () => {
      paymentModel.findById.mockReturnValue(chain(pago()));
      const q = chain([
        intento(),
        intento({
          origen: 'WEBHOOK',
          resultado: 'DECLINED',
          motivo: 'FRAUDE',
          createdAt: new Date('2026-11-08T12:05:00.000Z'),
        }),
      ]);
      attemptModel.find.mockReturnValue(q);

      const view = await service.getAdmin(ID.toString());

      expect(paymentModel.findById).toHaveBeenCalledWith(ID.toString());
      expect(attemptModel.find).toHaveBeenCalledWith({ paymentId: ID });
      expect(q.sort).toHaveBeenCalledWith({ createdAt: 1, _id: 1 });
      expect(view).toMatchObject({ id: ID.toString(), buyerId: BUYER });
      expect(view.attempts).toEqual([
        {
          origen: 'SIMULATOR',
          resultado: 'PROCESSING',
          motivo: undefined,
          createdAt: CREATED,
        },
        {
          origen: 'WEBHOOK',
          resultado: 'DECLINED',
          motivo: 'FRAUDE',
          createdAt: new Date('2026-11-08T12:05:00.000Z'),
        },
      ]);
    });

    it('los intentos solo exponen origen, resultado, motivo y fecha', async () => {
      paymentModel.findById.mockReturnValue(chain(pago()));
      attemptModel.find.mockReturnValue(chain([intento()]));

      const view = await service.getAdmin(ID.toString());

      expect(Object.keys(view.attempts[0]!).sort()).toEqual([
        'createdAt',
        'motivo',
        'origen',
        'resultado',
      ]);
      const texto = JSON.stringify(view);
      for (const prohibido of ['idempotencyKey', 'requestHash', 'eventId']) {
        expect(texto).not.toContain(prohibido);
      }
    });

    it('pago inexistente: 404 sin consultar intentos', async () => {
      paymentModel.findById.mockReturnValue(chain(null));

      await expect(service.getAdmin(ID.toString())).rejects.toBeInstanceOf(
        NotFoundException,
      );
      expect(attemptModel.find).not.toHaveBeenCalled();
    });
  });
});

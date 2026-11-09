import { NotFoundException } from '@nestjs/common';
import { Types } from 'mongoose';
import {
  NotificationsQueryService,
  toNotificationView,
} from './notifications-query.service.js';

const doc = (over: Record<string, unknown> = {}) => ({
  _id: new Types.ObjectId('64b7f0c2a1b2c3d4e5f60700'),
  eventId: 'evt-1',
  eventType: 'payment.approved',
  correlationId: '64b7f0c2a1b2c3d4e5f60711',
  destinatarioTipo: 'USER' as const,
  destinatarioId: new Types.ObjectId('64b7f0c2a1b2c3d4e5f60718'),
  plantilla: 'PAYMENT_APPROVED' as const,
  titulo: 'Pago aprobado',
  mensaje: 'Tu pago fue aprobado',
  canal: 'SIMULATED',
  sentAt: new Date('2026-11-09T10:00:00.000Z'),
  ...over,
});

describe('toNotificationView', () => {
  it('mapea los campos públicos con fechas ISO y readAt nulo si no se leyó', () => {
    expect(toNotificationView(doc() as never)).toEqual({
      id: '64b7f0c2a1b2c3d4e5f60700',
      plantilla: 'PAYMENT_APPROVED',
      destinatarioTipo: 'USER',
      titulo: 'Pago aprobado',
      mensaje: 'Tu pago fue aprobado',
      orderId: '64b7f0c2a1b2c3d4e5f60711',
      sentAt: '2026-11-09T10:00:00.000Z',
      readAt: null,
    });
  });

  it('devuelve readAt en ISO cuando el aviso está leído', () => {
    const view = toNotificationView(
      doc({ readAt: new Date('2026-11-09T11:00:00.000Z') }) as never,
    );
    expect(view.readAt).toBe('2026-11-09T11:00:00.000Z');
  });

  it.each(['order.confirmed', 'order.cancelled', 'payment.declined'])(
    'orderId es el correlationId en %s',
    (eventType) => {
      expect(toNotificationView(doc({ eventType }) as never).orderId).toBe(
        '64b7f0c2a1b2c3d4e5f60711',
      );
    },
  );

  it.each(['user.registered', 'provider.approved', 'provider.rejected'])(
    'orderId es null en %s',
    (eventType) => {
      expect(
        toNotificationView(doc({ eventType }) as never).orderId,
      ).toBeNull();
    },
  );

  it('no expone eventId, eventType, correlationId, destinatarioId ni canal', () => {
    const view = toNotificationView(doc() as never);
    for (const campo of [
      'eventId',
      'eventType',
      'correlationId',
      'destinatarioId',
      'canal',
    ]) {
      expect(view).not.toHaveProperty(campo);
    }
  });
});

const USER = '64b7f0c2a1b2c3d4e5f60718';
const STORE = '64b7f0c2a1b2c3d4e5f60719';
const actor = { userId: USER, storeId: STORE };
const withId = (n: number) =>
  doc({ _id: new Types.ObjectId(n.toString(16).padStart(24, '0')) });

describe('NotificationsQueryService', () => {
  const chain = { sort: vi.fn(), limit: vi.fn(), lean: vi.fn() };
  const model = {
    find: vi.fn(),
    findOne: vi.fn(),
    countDocuments: vi.fn(),
    updateOne: vi.fn(),
    updateMany: vi.fn(),
  };
  let service: NotificationsQueryService;

  beforeEach(() => {
    vi.resetAllMocks();
    chain.sort.mockReturnValue(chain);
    chain.limit.mockReturnValue(chain);
    model.find.mockReturnValue(chain);
    model.findOne.mockReturnValue({ lean: chain.lean });
    service = new NotificationsQueryService(model as never);
  });

  describe('list', () => {
    it('ordena por _id descendente, pide limit + 1 y filtra por el actor', async () => {
      chain.lean.mockResolvedValue([]);

      await service.list(actor, { limit: 20 });

      const [filter] = model.find.mock.calls[0];
      expect(filter.$or).toHaveLength(2);
      expect(chain.sort).toHaveBeenCalledWith({ _id: -1 });
      expect(chain.limit).toHaveBeenCalledWith(21);
    });

    it('devuelve nextCursor (id del último devuelto) si hay una página más', async () => {
      chain.lean.mockResolvedValue([withId(3), withId(2), withId(1)]);

      const page = await service.list(actor, { limit: 2 });

      expect(page.data).toHaveLength(2);
      expect(page.nextCursor).toBe(String(withId(2)._id));
    });

    it('devuelve nextCursor null en la última página', async () => {
      chain.lean.mockResolvedValue([withId(2), withId(1)]);

      const page = await service.list(actor, { limit: 2 });

      expect(page.data).toHaveLength(2);
      expect(page.nextCursor).toBeNull();
    });

    it('con cursor suma _id < cursor sin quitar el filtro del actor', async () => {
      chain.lean.mockResolvedValue([]);

      await service.list({ userId: USER }, { limit: 5, cursor: STORE });

      const [filter] = model.find.mock.calls[0];
      expect(filter._id).toEqual({ $lt: STORE });
      expect(filter.$or).toEqual([
        { destinatarioTipo: 'USER', destinatarioId: USER },
      ]);
    });

    it('devuelve vistas, no documentos', async () => {
      chain.lean.mockResolvedValue([withId(1)]);

      const { data } = await service.list(actor, { limit: 20 });

      expect(data[0]).not.toHaveProperty('eventId');
      expect(data[0]).toHaveProperty('orderId');
    });
  });

  describe('unreadCount', () => {
    it('cuenta los del actor sin readAt', async () => {
      model.countDocuments.mockResolvedValue(4);

      expect(await service.unreadCount(actor)).toEqual({ count: 4 });

      const [filter] = model.countDocuments.mock.calls[0];
      expect(filter.readAt).toEqual({ $exists: false });
      expect(filter.$or).toHaveLength(2);
    });
  });

  describe('markRead', () => {
    const ID = '64b7f0c2a1b2c3d4e5f60700';

    it('marca solo si no estaba leído y con el filtro del actor', async () => {
      chain.lean.mockResolvedValue(doc({ readAt: new Date() }));

      const view = await service.markRead(actor, ID);

      const [filter, update] = model.updateOne.mock.calls[0];
      expect(filter).toMatchObject({ _id: ID, readAt: { $exists: false } });
      expect(filter.$or).toHaveLength(2);
      expect(update.$set.readAt).toBeInstanceOf(Date);
      expect(view.readAt).not.toBeNull();
    });

    it('lee con el filtro del actor, sin condición sobre readAt', async () => {
      chain.lean.mockResolvedValue(doc());

      await service.markRead(actor, ID);

      const [filter] = model.findOne.mock.calls[0];
      expect(filter._id).toBe(ID);
      expect(filter.$or).toHaveLength(2);
      expect(filter).not.toHaveProperty('readAt');
    });

    it('un aviso ya leído se devuelve con su readAt original', async () => {
      const original = new Date('2026-11-01T00:00:00.000Z');
      chain.lean.mockResolvedValue(doc({ readAt: original }));

      const view = await service.markRead(actor, ID);

      expect(view.readAt).toBe(original.toISOString());
    });

    it('lanza 404 si el aviso no es del actor o no existe', async () => {
      chain.lean.mockResolvedValue(null);

      await expect(service.markRead(actor, ID)).rejects.toBeInstanceOf(
        NotFoundException,
      );
    });
  });

  describe('markAllRead', () => {
    it('actualiza solo los del actor sin leer y devuelve modifiedCount', async () => {
      model.updateMany.mockResolvedValue({ modifiedCount: 3 });

      expect(await service.markAllRead(actor)).toEqual({ updated: 3 });

      const [filter, update] = model.updateMany.mock.calls[0];
      expect(filter.readAt).toEqual({ $exists: false });
      expect(filter.$or).toHaveLength(2);
      expect(update.$set.readAt).toBeInstanceOf(Date);
    });
  });
});

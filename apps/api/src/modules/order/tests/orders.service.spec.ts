import { NotFoundException } from '@nestjs/common';
import { Types } from 'mongoose';
import { OrdersService } from '../services/orders.service.js';

const BUYER = 'b1'.repeat(12);
const ORDER_ID = new Types.ObjectId();
const SUB_ID = new Types.ObjectId();
const STORE = new Types.ObjectId();
const CREATED = new Date('2026-11-08T12:00:00.000Z');

const orden = (extra: Record<string, unknown> = {}) => ({
  _id: ORDER_ID,
  buyerId: new Types.ObjectId(BUYER),
  total: 3000,
  moneda: 'COP' as const,
  status: 'PENDING' as const,
  createdAt: CREATED,
  ...extra,
});

/** Encadena `.sort().skip().limit().lean()` como lo hace Mongoose. */
const chain = <T>(value: T) => {
  const q: Record<string, unknown> = {
    sort: vi.fn(() => q),
    skip: vi.fn(() => q),
    limit: vi.fn(() => q),
    lean: () => Promise.resolve(value),
  };
  return q;
};

describe('OrdersService', () => {
  const orderModel = {
    find: vi.fn(),
    findOne: vi.fn(),
    countDocuments: vi.fn(),
  };
  const subOrderModel = { find: vi.fn() };
  const orderItemModel = { find: vi.fn() };
  let service: OrdersService;

  beforeEach(() => {
    vi.resetAllMocks();
    service = new OrdersService(
      orderModel as never,
      subOrderModel as never,
      orderItemModel as never,
    );
  });

  describe('listMine', () => {
    it('lista solo los pedidos del comprador, del más reciente al más antiguo', async () => {
      const q = chain([orden()]);
      orderModel.find.mockReturnValue(q);
      orderModel.countDocuments.mockResolvedValue(1);

      const page = await service.listMine(BUYER, { page: 1, limit: 20 });

      expect(orderModel.find).toHaveBeenCalledWith({ buyerId: BUYER });
      expect(q.sort).toHaveBeenCalledWith({ createdAt: -1, _id: -1 });
      expect(page).toEqual({
        data: [
          {
            id: ORDER_ID.toString(),
            total: 3000,
            moneda: 'COP',
            status: 'PENDING',
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
      orderModel.find.mockReturnValue(q);
      orderModel.countDocuments.mockResolvedValue(45);

      const page = await service.listMine(BUYER, { page: 3, limit: 10 });

      expect(q.skip).toHaveBeenCalledWith(20);
      expect(q.limit).toHaveBeenCalledWith(10);
      expect(page.total).toBe(45);
    });

    it('filtra por status cuando se pide', async () => {
      orderModel.find.mockReturnValue(chain([]));
      orderModel.countDocuments.mockResolvedValue(0);

      await service.listMine(BUYER, {
        page: 1,
        limit: 20,
        status: 'CONFIRMED',
      });

      const filter = { buyerId: BUYER, status: 'CONFIRMED' };
      expect(orderModel.find).toHaveBeenCalledWith(filter);
      expect(orderModel.countDocuments).toHaveBeenCalledWith(filter);
    });

    it('incluye expiresAt cuando el pedido espera pago', async () => {
      const expiresAt = new Date('2026-11-08T12:15:00.000Z');
      orderModel.find.mockReturnValue(
        chain([orden({ status: 'AWAITING_PAYMENT', expiresAt })]),
      );
      orderModel.countDocuments.mockResolvedValue(1);

      const page = await service.listMine(BUYER, { page: 1, limit: 20 });

      expect(page.data[0].expiresAt).toEqual(expiresAt);
    });
  });

  describe('getMine', () => {
    it('devuelve el pedido propio con sub-pedidos e ítems', async () => {
      orderModel.findOne.mockReturnValue(chain(orden()));
      subOrderModel.find.mockReturnValue(
        chain([{ _id: SUB_ID, storeId: STORE, subtotal: 3000 }]),
      );
      orderItemModel.find.mockReturnValue(
        chain([
          {
            _id: new Types.ObjectId(),
            subOrderId: SUB_ID,
            variantId: new Types.ObjectId(),
            productId: new Types.ObjectId(),
            nombreProducto: 'Herbicida',
            presentacion: '4 L',
            unidad: 'L',
            precioUnitario: 1000,
            cantidad: 3,
            subtotal: 3000,
          },
        ]),
      );

      const order = await service.getMine(BUYER, ORDER_ID.toString());

      expect(orderModel.findOne).toHaveBeenCalledWith({
        _id: ORDER_ID.toString(),
        buyerId: BUYER,
      });
      expect(order.buyerId).toBe(BUYER);
      expect(order.subOrders).toHaveLength(1);
      expect(order.subOrders[0].storeId).toBe(STORE.toString());
      expect(order.subOrders[0].items[0]).toMatchObject({
        nombreProducto: 'Herbicida',
        precioUnitario: 1000,
        cantidad: 3,
      });
    });

    it('un pedido ajeno o inexistente da 404', async () => {
      orderModel.findOne.mockReturnValue(chain(null));

      await expect(
        service.getMine(BUYER, ORDER_ID.toString()),
      ).rejects.toBeInstanceOf(NotFoundException);
      expect(subOrderModel.find).not.toHaveBeenCalled();
    });
  });
});

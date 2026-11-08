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
    findById: vi.fn(),
    exists: vi.fn(),
    countDocuments: vi.fn(),
  };
  const subOrderModel = {
    find: vi.fn(),
    findOne: vi.fn(),
    aggregate: vi.fn(),
  };
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

  const itemDe = (subOrderId: Types.ObjectId) => ({
    _id: new Types.ObjectId(),
    subOrderId,
    variantId: new Types.ObjectId(),
    productId: new Types.ObjectId(),
    nombreProducto: 'Herbicida',
    presentacion: '4 L',
    unidad: 'L',
    precioUnitario: 1000,
    cantidad: 2,
    subtotal: 2000,
  });
  const STORE_ID = STORE.toString();

  describe('listProviderSubOrders', () => {
    it('sin storeId devuelve la lista vacía sin consultar Mongo', async () => {
      const page = await service.listProviderSubOrders(undefined, {
        page: 1,
        limit: 20,
      });

      expect(page).toEqual({ data: [], page: 1, limit: 20, total: 0 });
      expect(subOrderModel.aggregate).not.toHaveBeenCalled();
    });

    it('un storeId que no es ObjectId tampoco consulta Mongo', async () => {
      const page = await service.listProviderSubOrders('{"$ne": null}', {
        page: 1,
        limit: 20,
      });

      expect(page.total).toBe(0);
      expect(subOrderModel.aggregate).not.toHaveBeenCalled();
    });

    it('filtra por su tienda y por pedidos CONFIRMED, sin buyerId ni total', async () => {
      subOrderModel.aggregate.mockResolvedValue([
        {
          data: [
            {
              _id: SUB_ID,
              orderId: ORDER_ID,
              storeId: STORE,
              subtotal: 2000,
              createdAt: CREATED,
            },
          ],
          total: [{ n: 1 }],
        },
      ]);
      orderItemModel.find.mockReturnValue(chain([itemDe(SUB_ID)]));

      const page = await service.listProviderSubOrders(STORE_ID, {
        page: 2,
        limit: 10,
      });

      const [pipeline] = subOrderModel.aggregate.mock.calls[0];
      expect(pipeline[0]).toEqual({ $match: { storeId: STORE } });
      expect(pipeline).toContainEqual({
        $match: { 'order.status': 'CONFIRMED' },
      });
      expect(JSON.stringify(pipeline)).toContain('"$skip":10');
      expect(page.total).toBe(1);
      expect(page.data[0]).toMatchObject({
        id: SUB_ID.toString(),
        orderId: ORDER_ID.toString(),
        status: 'CONFIRMED',
        subtotal: 2000,
        createdAt: CREATED,
      });
      expect(page.data[0].items).toHaveLength(1);
      const json = JSON.stringify(page);
      expect(json).not.toContain('buyerId');
      expect(json).not.toContain('"total":2000');
    });

    it('sin resultados devuelve la página vacía', async () => {
      subOrderModel.aggregate.mockResolvedValue([{ data: [], total: [] }]);

      const page = await service.listProviderSubOrders(STORE_ID, {
        page: 1,
        limit: 20,
      });

      expect(page).toEqual({ data: [], page: 1, limit: 20, total: 0 });
      expect(orderItemModel.find).not.toHaveBeenCalled();
    });
  });

  describe('getProviderSubOrder', () => {
    const subOrder = {
      _id: SUB_ID,
      orderId: ORDER_ID,
      storeId: STORE,
      subtotal: 2000,
      createdAt: CREATED,
    };

    it('devuelve el sub-pedido de su tienda cuando el pedido está CONFIRMED', async () => {
      subOrderModel.findOne.mockReturnValue(chain(subOrder));
      orderModel.exists.mockResolvedValue({ _id: ORDER_ID });
      orderItemModel.find.mockReturnValue(chain([itemDe(SUB_ID)]));

      const view = await service.getProviderSubOrder(
        STORE_ID,
        SUB_ID.toString(),
      );

      expect(subOrderModel.findOne).toHaveBeenCalledWith({
        _id: SUB_ID.toString(),
        storeId: STORE_ID,
      });
      expect(orderModel.exists).toHaveBeenCalledWith({
        _id: ORDER_ID,
        status: 'CONFIRMED',
      });
      expect(view.items).toHaveLength(1);
      expect(JSON.stringify(view)).not.toContain('buyerId');
    });

    it('uno de otra tienda da 404', async () => {
      subOrderModel.findOne.mockReturnValue(chain(null));

      await expect(
        service.getProviderSubOrder(STORE_ID, SUB_ID.toString()),
      ).rejects.toBeInstanceOf(NotFoundException);
    });

    it('uno sin pagar da 404', async () => {
      subOrderModel.findOne.mockReturnValue(chain(subOrder));
      orderModel.exists.mockResolvedValue(null);

      await expect(
        service.getProviderSubOrder(STORE_ID, SUB_ID.toString()),
      ).rejects.toBeInstanceOf(NotFoundException);
      expect(orderItemModel.find).not.toHaveBeenCalled();
    });

    it('sin storeId en el token da 404 sin consultar Mongo', async () => {
      await expect(
        service.getProviderSubOrder(undefined, SUB_ID.toString()),
      ).rejects.toBeInstanceOf(NotFoundException);
      expect(subOrderModel.findOne).not.toHaveBeenCalled();
    });
  });

  describe('listAll (ADMIN)', () => {
    it('lista todos los pedidos con el comprador y sin filtro por defecto', async () => {
      orderModel.find.mockReturnValue(chain([orden()]));
      orderModel.countDocuments.mockResolvedValue(1);

      const page = await service.listAll({ page: 1, limit: 20 });

      expect(orderModel.find).toHaveBeenCalledWith({});
      expect(page.data[0]).toMatchObject({
        id: ORDER_ID.toString(),
        buyerId: BUYER,
        status: 'PENDING',
      });
    });

    it('filtra por status y buyerId', async () => {
      orderModel.find.mockReturnValue(chain([]));
      orderModel.countDocuments.mockResolvedValue(0);

      await service.listAll({
        page: 1,
        limit: 20,
        status: 'CANCELLED',
        buyerId: BUYER,
      });

      const filter = { status: 'CANCELLED', buyerId: BUYER };
      expect(orderModel.find).toHaveBeenCalledWith(filter);
      expect(orderModel.countDocuments).toHaveBeenCalledWith(filter);
    });
  });

  describe('getAny (ADMIN)', () => {
    it('devuelve el detalle completo de cualquier pedido', async () => {
      orderModel.findById.mockReturnValue(chain(orden()));
      subOrderModel.find.mockReturnValue(
        chain([{ _id: SUB_ID, storeId: STORE, subtotal: 3000 }]),
      );
      orderItemModel.find.mockReturnValue(chain([itemDe(SUB_ID)]));

      const order = await service.getAny(ORDER_ID.toString());

      expect(order.buyerId).toBe(BUYER);
      expect(order.subOrders[0].items).toHaveLength(1);
    });

    it('un pedido inexistente da 404', async () => {
      orderModel.findById.mockReturnValue(chain(null));

      await expect(service.getAny(ORDER_ID.toString())).rejects.toBeInstanceOf(
        NotFoundException,
      );
    });
  });
});

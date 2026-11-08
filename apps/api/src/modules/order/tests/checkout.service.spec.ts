import { BadRequestException } from '@nestjs/common';
import { Types } from 'mongoose';
import { CheckoutService } from '../services/checkout.service.js';

const BUYER = '6aee7a351616d80ba08c95aa';
const KEY = 'clave-de-prueba-1';
const CART_ID = new Types.ObjectId();
const V1 = 'a1'.repeat(12);
const V2 = 'a2'.repeat(12);
const STORE_A = 'b1'.repeat(12);
const STORE_B = 'b2'.repeat(12);

const variante = (
  variantId: string,
  storeId: string,
  extra: Record<string, unknown> = {},
) => ({
  variantId,
  productId: 'c1'.repeat(12),
  storeId,
  nombreProducto: 'Herbicida',
  presentacion: '4 L',
  unidad: 'L',
  precioVigente: 1000,
  disponible: 10,
  apta: true,
  ...extra,
});

const linea = (variantId: string, cantidad: number) => ({
  cartId: CART_ID,
  variantId: new Types.ObjectId(variantId),
  cantidad,
});

/** Encadena `.lean()`, `.sort()` y `.select()` como lo hace Mongoose. */
const chain = <T>(value: T) => {
  const q: Record<string, unknown> = {
    lean: () => Promise.resolve(value),
    sort: () => q,
    select: () => q,
  };
  return q;
};

describe('CheckoutService.checkout', () => {
  const session = { id: 'sesion' };
  const connection = { startSession: vi.fn() };
  const endSession = vi.fn();
  const cartModel = { findOne: vi.fn() };
  const cartItemModel = { find: vi.fn(), deleteMany: vi.fn() };
  const orderModel = { findOne: vi.fn(), findById: vi.fn(), create: vi.fn() };
  const subOrderModel = { find: vi.fn(), create: vi.fn() };
  const orderItemModel = { find: vi.fn(), create: vi.fn() };
  const catalog = { getCheckoutVariants: vi.fn() };
  const outbox = { add: vi.fn() };
  let service: CheckoutService;

  /** Lo que `create` guardó, para armar la lectura posterior del pedido. */
  const stored: { order?: any; subOrders: any[]; items: any[] } = {
    subOrders: [],
    items: [],
  };

  beforeEach(() => {
    vi.resetAllMocks();
    stored.order = undefined;
    stored.subOrders = [];
    stored.items = [];

    connection.startSession.mockResolvedValue({
      ...session,
      endSession,
      withTransaction: async (fn: () => Promise<unknown>) => fn(),
    });
    cartModel.findOne.mockReturnValue(chain({ _id: CART_ID }));
    orderModel.findOne.mockReturnValue(chain(null));
    orderModel.create.mockImplementation(async ([doc]: any[]) => {
      stored.order = {
        ...doc,
        moneda: 'COP',
        status: 'PENDING',
        createdAt: new Date(),
      };
    });
    subOrderModel.create.mockImplementation(async (docs: any[]) => {
      stored.subOrders = docs;
    });
    orderItemModel.create.mockImplementation(async (docs: any[]) => {
      stored.items = docs.map((d) => ({ ...d, _id: new Types.ObjectId() }));
    });
    orderModel.findById.mockImplementation(() => chain(stored.order));
    subOrderModel.find.mockImplementation(() => chain(stored.subOrders));
    orderItemModel.find.mockImplementation(() => chain(stored.items));
    outbox.add.mockResolvedValue('evento-1');

    service = new CheckoutService(
      connection as never,
      cartModel as never,
      cartItemModel as never,
      orderModel as never,
      subOrderModel as never,
      orderItemModel as never,
      catalog as never,
      outbox as never,
    );
  });

  const conCarrito = (
    lineas: ReturnType<typeof linea>[],
    variantes: ReturnType<typeof variante>[],
  ) => {
    cartItemModel.find.mockReturnValue(chain(lineas));
    catalog.getCheckoutVariants.mockResolvedValue(variantes);
  };

  it('toma el precio de catálogo, guarda el snapshot y calcula el total', async () => {
    conCarrito([linea(V1, 3)], [variante(V1, STORE_A, { precioVigente: 800 })]);

    const { order, created } = await service.checkout(BUYER, KEY);

    expect(created).toBe(true);
    expect(order.status).toBe('PENDING');
    expect(order.moneda).toBe('COP');
    expect(order.total).toBe(2400);
    const [[items]] = orderItemModel.create.mock.calls;
    expect(items[0]).toMatchObject({
      precioUnitario: 800,
      cantidad: 3,
      subtotal: 2400,
      nombreProducto: 'Herbicida',
      presentacion: '4 L',
      unidad: 'L',
    });
    expect(order.subOrders[0].items[0].precioUnitario).toBe(800);
  });

  it('con una sola tienda crea un solo SubOrder', async () => {
    conCarrito(
      [linea(V1, 1), linea(V2, 2)],
      [variante(V1, STORE_A), variante(V2, STORE_A)],
    );

    const { order } = await service.checkout(BUYER, KEY);

    expect(subOrderModel.create.mock.calls[0][0]).toHaveLength(1);
    expect(order.subOrders).toHaveLength(1);
    expect(order.subOrders[0].items).toHaveLength(2);
    expect(order.total).toBe(3000);
  });

  it('con ítems de dos tiendas crea dos SubOrder con su subtotal', async () => {
    conCarrito(
      [linea(V1, 1), linea(V2, 2)],
      [variante(V1, STORE_A), variante(V2, STORE_B)],
    );

    const { order } = await service.checkout(BUYER, KEY);

    const subOrders = subOrderModel.create.mock.calls[0][0];
    expect(subOrders.map((s: any) => [s.storeId, s.subtotal])).toEqual([
      [STORE_A, 1000],
      [STORE_B, 2000],
    ]);
    expect(order.total).toBe(3000);
    // cada ítem cuelga del SubOrder de su tienda
    const items = orderItemModel.create.mock.calls[0][0];
    expect(items[0].subOrderId).toBe(subOrders[0]._id);
    expect(items[1].subOrderId).toBe(subOrders[1]._id);
  });

  it('deja order.created en el outbox, con la misma sesión, y vacía el carrito', async () => {
    conCarrito([linea(V1, 2)], [variante(V1, STORE_A)]);

    const { order } = await service.checkout(BUYER, KEY);

    expect(outbox.add).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'sesion' }),
      'order.created',
      order.id,
      {
        orderId: order.id,
        items: [{ variantId: V1, cantidad: 2 }],
        buyerId: BUYER,
        total: 2000,
      },
    );
    expect(cartItemModel.deleteMany).toHaveBeenCalledWith(
      { cartId: CART_ID },
      { session: expect.objectContaining({ id: 'sesion' }) },
    );
    expect(endSession).toHaveBeenCalled();
  });

  it('rechaza requiresQuote/no apta con 400 y el detalle de la línea, sin crear nada', async () => {
    conCarrito(
      [linea(V1, 1), linea(V2, 1)],
      [variante(V1, STORE_A), variante(V2, STORE_A, { apta: false })],
    );

    const error = await service.checkout(BUYER, KEY).catch((e) => e);

    expect(error).toBeInstanceOf(BadRequestException);
    expect(error.getResponse().lineas).toEqual([
      { variantId: V2, motivo: 'NOT_APTA' },
    ]);
    expect(orderModel.create).not.toHaveBeenCalled();
    expect(outbox.add).not.toHaveBeenCalled();
    expect(cartItemModel.deleteMany).not.toHaveBeenCalled();
  });

  it('rechaza una variante inexistente con NOT_FOUND', async () => {
    conCarrito([linea(V1, 1)], []);

    const error = await service.checkout(BUYER, KEY).catch((e) => e);

    expect(error).toBeInstanceOf(BadRequestException);
    expect(error.getResponse().lineas).toEqual([
      { variantId: V1, motivo: 'NOT_FOUND' },
    ]);
  });

  it('rechaza un carrito vacío con 400', async () => {
    conCarrito([], []);

    await expect(service.checkout(BUYER, KEY)).rejects.toBeInstanceOf(
      BadRequestException,
    );
    expect(orderModel.create).not.toHaveBeenCalled();
  });

  it('rechaza con 400 si el comprador no tiene carrito', async () => {
    cartModel.findOne.mockReturnValue(chain(null));

    await expect(service.checkout(BUYER, KEY)).rejects.toBeInstanceOf(
      BadRequestException,
    );
  });

  it('una clave repetida devuelve el mismo pedido sin crear otro ni otro order.created', async () => {
    const id = new Types.ObjectId();
    stored.order = {
      _id: id,
      buyerId: new Types.ObjectId(BUYER),
      total: 1000,
      moneda: 'COP',
      status: 'PENDING',
      createdAt: new Date(),
    };
    orderModel.findOne.mockReturnValue(chain({ _id: id }));

    const { order, created } = await service.checkout(BUYER, KEY);

    expect(created).toBe(false);
    expect(order.id).toBe(id.toString());
    expect(orderModel.findOne).toHaveBeenCalledWith({
      buyerId: BUYER,
      idempotencyKey: KEY,
    });
    expect(orderModel.create).not.toHaveBeenCalled();
    expect(outbox.add).not.toHaveBeenCalled();
    expect(catalog.getCheckoutVariants).not.toHaveBeenCalled();
  });

  it('doble clic simultáneo: el insert choca (11000) y devuelve el pedido ganador', async () => {
    conCarrito([linea(V1, 1)], [variante(V1, STORE_A)]);
    const winnerId = new Types.ObjectId();
    orderModel.findOne
      .mockReturnValueOnce(chain(null))
      .mockReturnValueOnce(chain({ _id: winnerId }));
    orderModel.create.mockRejectedValue({ code: 11000 });
    orderModel.findById.mockImplementation(() =>
      chain({
        _id: winnerId,
        buyerId: new Types.ObjectId(BUYER),
        total: 1000,
        moneda: 'COP',
        status: 'PENDING',
        createdAt: new Date(),
      }),
    );

    const { order, created } = await service.checkout(BUYER, KEY);

    expect(created).toBe(false);
    expect(order.id).toBe(winnerId.toString());
    expect(outbox.add).not.toHaveBeenCalled();
  });

  it('si algún insert falla propaga el error y no deja evento ni carrito vaciado', async () => {
    conCarrito([linea(V1, 1)], [variante(V1, STORE_A)]);
    orderItemModel.create.mockRejectedValue(new Error('boom'));

    await expect(service.checkout(BUYER, KEY)).rejects.toThrow('boom');

    expect(outbox.add).not.toHaveBeenCalled();
    expect(cartItemModel.deleteMany).not.toHaveBeenCalled();
    expect(endSession).toHaveBeenCalled();
  });
});

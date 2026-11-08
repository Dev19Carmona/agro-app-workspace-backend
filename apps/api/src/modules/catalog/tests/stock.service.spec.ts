import {
  ConflictException,
  ForbiddenException,
  NotFoundException,
} from '@nestjs/common';
import { Types } from 'mongoose';
import { StockService } from '../services/stock.service.js';

const oid = () => new Types.ObjectId();
const OWNER = oid().toString();
const STORE_ID = oid();
const PRODUCT_ID = oid();
const VARIANT_ID = oid().toString();

const variante = (extra: Record<string, unknown> = {}) => ({
  _id: new Types.ObjectId(VARIANT_ID),
  productId: PRODUCT_ID,
  presentacion: '4 L',
  unidad: 'L',
  precio: 1000,
  stock: 10,
  stockReservado: 4,
  activo: true,
  ...extra,
});
const lean = (valor: unknown) => ({ lean: async () => valor });

describe('StockService.setStock', () => {
  const storeFindOne = vi.fn();
  const productExists = vi.fn();
  const variantFindById = vi.fn();
  const variantFindOneAndUpdate = vi.fn();
  let service: StockService;

  beforeEach(() => {
    vi.resetAllMocks();
    storeFindOne.mockReturnValue(lean({ _id: STORE_ID }));
    variantFindById.mockReturnValue(lean(variante()));
    productExists.mockResolvedValue({ _id: PRODUCT_ID });
    service = new StockService(
      { findOne: storeFindOne } as never,
      { exists: productExists } as never,
      {
        findById: variantFindById,
        findOneAndUpdate: variantFindOneAndUpdate,
      } as never,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
    );
  });

  it('fija el stock con una actualización condicional stockReservado <= stock', async () => {
    variantFindOneAndUpdate.mockReturnValue(lean(variante({ stock: 20 })));

    const view = await service.setStock(OWNER, VARIANT_ID, 20);

    expect(productExists).toHaveBeenCalledWith({
      _id: PRODUCT_ID,
      storeId: STORE_ID,
    });
    expect(variantFindOneAndUpdate).toHaveBeenCalledWith(
      { _id: VARIANT_ID, $expr: { $lte: ['$stockReservado', 20] } },
      { $set: { stock: 20 } },
      { new: true },
    );
    expect(view).toMatchObject({ stock: 20, disponible: 16 });
  });

  it('acepta un stock igual al reservado', async () => {
    variantFindOneAndUpdate.mockReturnValue(lean(variante({ stock: 4 })));

    const view = await service.setStock(OWNER, VARIANT_ID, 4);

    expect(view.disponible).toBe(0);
  });

  it('responde 409 si stock < stockReservado (la condición no encuentra la variante)', async () => {
    variantFindOneAndUpdate.mockReturnValue(lean(null));

    await expect(service.setStock(OWNER, VARIANT_ID, 3)).rejects.toBeInstanceOf(
      ConflictException,
    );
    expect(variantFindOneAndUpdate).toHaveBeenCalledWith(
      { _id: VARIANT_ID, $expr: { $lte: ['$stockReservado', 3] } },
      { $set: { stock: 3 } },
      { new: true },
    );
  });

  it('responde 404 si la variante pertenece a un producto de otra tienda', async () => {
    productExists.mockResolvedValue(null);

    await expect(service.setStock(OWNER, VARIANT_ID, 5)).rejects.toBeInstanceOf(
      NotFoundException,
    );
    expect(variantFindOneAndUpdate).not.toHaveBeenCalled();
  });

  it('responde 404 si la variante no existe', async () => {
    variantFindById.mockReturnValue(lean(null));

    await expect(service.setStock(OWNER, VARIANT_ID, 5)).rejects.toBeInstanceOf(
      NotFoundException,
    );
    expect(productExists).not.toHaveBeenCalled();
    expect(variantFindOneAndUpdate).not.toHaveBeenCalled();
  });

  it('responde 403 si el PROVEEDOR no tiene tienda', async () => {
    storeFindOne.mockReturnValue(lean(null));

    await expect(service.setStock(OWNER, VARIANT_ID, 5)).rejects.toBeInstanceOf(
      ForbiddenException,
    );
    expect(variantFindOneAndUpdate).not.toHaveBeenCalled();
  });
});

const oidStr = () => new Types.ObjectId().toString();

const V1 = oidStr();
const V2 = oidStr();

const evento = (items: { variantId: string; cantidad: number }[]) => ({
  eventId: 'evt-1',
  type: 'order.created' as const,
  occurredAt: '2026-11-07T00:00:00.000Z',
  correlationId: 'order-1',
  payload: { orderId: 'order-1', items },
});

const checkout = (variantId: string, extra: Record<string, unknown> = {}) => ({
  variantId,
  disponible: 10,
  apta: true,
  ...extra,
});

describe('StockService.reserve', () => {
  const processedExists = vi.fn();
  const processedCreate = vi.fn();
  const reservationCreate = vi.fn();
  const updateOne = vi.fn();
  const getCheckoutVariants = vi.fn();
  const emit = vi.fn();
  const endSession = vi.fn();
  const session = { endSession, withTransaction: vi.fn() };
  const startSession = vi.fn();
  let service: StockService;

  beforeEach(() => {
    vi.resetAllMocks();
    session.withTransaction.mockImplementation(async (fn: () => unknown) => {
      await fn();
    });
    startSession.mockResolvedValue(session);
    processedExists.mockResolvedValue(null);
    getCheckoutVariants.mockImplementation(async (ids: string[]) =>
      ids.map((id) => checkout(id)),
    );
    updateOne.mockResolvedValue({ modifiedCount: 1 });
    service = new StockService(
      {} as never,
      {} as never,
      { updateOne } as never,
      { create: reservationCreate } as never,
      { exists: processedExists, create: processedCreate } as never,
      { startSession } as never,
      { emit } as never,
      { getCheckoutVariants } as never,
    );
  });

  it('con stock suficiente reserva, guarda RESERVED y emite stock.reserved', async () => {
    const items = [{ variantId: V1, cantidad: 4 }];

    await service.reserve(evento(items));

    expect(updateOne).toHaveBeenCalledWith(
      {
        _id: V1,
        activo: true,
        $expr: { $gte: [{ $subtract: ['$stock', '$stockReservado'] }, 4] },
      },
      { $inc: { stockReservado: 4 } },
      { session },
    );
    expect(reservationCreate).toHaveBeenCalledWith(
      [{ orderId: 'order-1', status: 'RESERVED', items }],
      { session },
    );
    expect(processedCreate).toHaveBeenCalledWith(
      [{ eventId: 'evt-1', type: 'order.created' }],
      { session },
    );
    expect(emit).toHaveBeenCalledTimes(1);
    const [nombre, sobre] = emit.mock.calls[0];
    expect(nombre).toBe('stock.reserved');
    expect(sobre).toMatchObject({
      type: 'stock.reserved',
      correlationId: 'order-1',
      payload: { orderId: 'order-1', items },
    });
    expect(sobre.eventId).toEqual(expect.any(String));
    expect(Date.parse(sobre.occurredAt)).not.toBeNaN();
    expect(endSession).toHaveBeenCalled();
  });

  it('si no alcanza aborta, guarda REJECTED y emite stock.rejected INSUFFICIENT_STOCK', async () => {
    updateOne.mockResolvedValue({ modifiedCount: 0 });
    getCheckoutVariants
      .mockImplementationOnce(async (ids: string[]) =>
        ids.map((id) => checkout(id)),
      )
      .mockImplementationOnce(async (ids: string[]) =>
        ids.map((id) => checkout(id, { disponible: 10 })),
      );
    const items = [{ variantId: V1, cantidad: 11 }];

    await service.reserve(evento(items));

    expect(session.withTransaction).toHaveBeenCalledTimes(2);
    // La reserva RESERVED nunca se creó: solo la REJECTED de la 2.ª transacción.
    expect(reservationCreate).toHaveBeenCalledTimes(1);
    expect(reservationCreate.mock.calls[0][0][0].status).toBe('REJECTED');
    const [nombre, sobre] = emit.mock.calls[0];
    expect(nombre).toBe('stock.rejected');
    expect(sobre.correlationId).toBe('order-1');
    expect(sobre.payload).toEqual({
      orderId: 'order-1',
      motivo: 'INSUFFICIENT_STOCK',
      items: [{ variantId: V1, cantidad: 11, disponible: 10 }],
    });
    expect(emit).toHaveBeenCalledTimes(1);
  });

  it('sin reserva parcial: si el 2.º ítem no alcanza, la transacción se aborta y solo se informa ese ítem', async () => {
    updateOne
      .mockResolvedValueOnce({ modifiedCount: 1 })
      .mockResolvedValueOnce({ modifiedCount: 0 });
    getCheckoutVariants
      .mockImplementationOnce(async (ids: string[]) =>
        ids.map((id) => checkout(id)),
      )
      .mockImplementationOnce(async () => [checkout(V2, { disponible: 2 })]);
    const items = [
      { variantId: V1, cantidad: 1 },
      { variantId: V2, cantidad: 5 },
    ];

    await service.reserve(evento(items));

    // La 1.ª transacción lanzó antes de crear la reserva => Mongo la revierte.
    const creadas = reservationCreate.mock.calls.map((c) => c[0][0].status);
    expect(creadas).toEqual(['REJECTED']);
    expect(emit.mock.calls[0][1].payload.items).toEqual([
      { variantId: V2, cantidad: 5, disponible: 2 },
    ]);
  });

  it('variante no apta o inexistente rechaza con VARIANT_UNAVAILABLE sin reservar', async () => {
    getCheckoutVariants.mockResolvedValue([
      checkout(V1, { apta: false, disponible: 3 }),
    ]);
    const items = [
      { variantId: V1, cantidad: 1 },
      { variantId: V2, cantidad: 1 },
    ];

    await service.reserve(evento(items));

    expect(updateOne).not.toHaveBeenCalled();
    const [nombre, sobre] = emit.mock.calls[0];
    expect(nombre).toBe('stock.rejected');
    expect(sobre.payload).toEqual({
      orderId: 'order-1',
      motivo: 'VARIANT_UNAVAILABLE',
      items: [
        { variantId: V1, cantidad: 1, disponible: 3 },
        { variantId: V2, cantidad: 1, disponible: 0 },
      ],
    });
    expect(reservationCreate.mock.calls[0][0][0].status).toBe('REJECTED');
  });

  it('un eventId ya procesado no reserva ni emite de nuevo', async () => {
    processedExists.mockResolvedValue({ _id: 'x' });

    await service.reserve(evento([{ variantId: V1, cantidad: 4 }]));

    expect(processedExists).toHaveBeenCalledWith({ eventId: 'evt-1' });
    expect(startSession).not.toHaveBeenCalled();
    expect(updateOne).not.toHaveBeenCalled();
    expect(emit).not.toHaveBeenCalled();
  });

  it('un duplicado concurrente (11000) se ignora sin emitir', async () => {
    processedCreate.mockRejectedValue({ code: 11000 });

    await service.reserve(evento([{ variantId: V1, cantidad: 4 }]));

    expect(emit).not.toHaveBeenCalled();
    expect(endSession).toHaveBeenCalled();
  });

  it('suma las cantidades de una misma variante repetida', async () => {
    await service.reserve(
      evento([
        { variantId: V1, cantidad: 2 },
        { variantId: V1, cantidad: 3 },
      ]),
    );

    expect(updateOne).toHaveBeenCalledTimes(1);
    expect(updateOne.mock.calls[0][1]).toEqual({ $inc: { stockReservado: 5 } });
  });

  it('propaga un error inesperado y cierra la sesión', async () => {
    const fallo = new Error('mongo caído');
    updateOne.mockRejectedValue(fallo);

    await expect(
      service.reserve(evento([{ variantId: V1, cantidad: 1 }])),
    ).rejects.toBe(fallo);
    expect(endSession).toHaveBeenCalled();
    expect(emit).not.toHaveBeenCalled();
  });
});

describe('StockService.confirm y release', () => {
  const findOneAndUpdate = vi.fn();
  const updateOne = vi.fn();
  const emit = vi.fn();
  const endSession = vi.fn();
  const session = { endSession, withTransaction: vi.fn() };
  let service: StockService;

  const reserva = () => ({
    orderId: 'order-1',
    status: 'RESERVED',
    items: [
      { variantId: new Types.ObjectId(V1), cantidad: 4 },
      { variantId: new Types.ObjectId(V2), cantidad: 2 },
    ],
  });
  const confirmado = (orderId = 'order-1') => ({
    eventId: 'evt-c',
    type: 'order.confirmed' as const,
    occurredAt: '2026-11-07T00:00:00.000Z',
    correlationId: orderId,
    payload: { orderId },
  });
  const cancelado = (orderId = 'order-1') => ({
    eventId: 'evt-x',
    type: 'order.cancelled' as const,
    occurredAt: '2026-11-07T00:00:00.000Z',
    correlationId: orderId,
    payload: { orderId },
  });
  const leanDe = (valor: unknown) => ({ lean: async () => valor });

  beforeEach(() => {
    vi.resetAllMocks();
    session.withTransaction.mockImplementation(async (fn: () => unknown) => {
      await fn();
    });
    updateOne.mockResolvedValue({ modifiedCount: 1 });
    service = new StockService(
      {} as never,
      {} as never,
      { updateOne } as never,
      { findOneAndUpdate } as never,
      {} as never,
      { startSession: async () => session } as never,
      { emit } as never,
      {} as never,
    );
  });

  describe('confirm', () => {
    it('sobre una reserva RESERVED resta stock y stockReservado y la deja CONFIRMED', async () => {
      findOneAndUpdate.mockReturnValue(leanDe(reserva()));

      await service.confirm(confirmado());

      expect(findOneAndUpdate).toHaveBeenCalledWith(
        { orderId: 'order-1', status: 'RESERVED' },
        { $set: { status: 'CONFIRMED' } },
        { session },
      );
      expect(updateOne).toHaveBeenCalledTimes(2);
      expect(updateOne).toHaveBeenCalledWith(
        { _id: new Types.ObjectId(V1) },
        { $inc: { stockReservado: -4, stock: -4 } },
        { session },
      );
      expect(updateOne).toHaveBeenCalledWith(
        { _id: new Types.ObjectId(V2) },
        { $inc: { stockReservado: -2, stock: -2 } },
        { session },
      );
      expect(emit).not.toHaveBeenCalled();
      expect(endSession).toHaveBeenCalled();
    });

    it('si la reserva no está RESERVED (o no existe) no toca ningún stock', async () => {
      findOneAndUpdate.mockReturnValue(leanDe(null));

      await service.confirm(confirmado());

      expect(updateOne).not.toHaveBeenCalled();
      expect(emit).not.toHaveBeenCalled();
    });
  });

  describe('release', () => {
    it('sobre una reserva RESERVED resta stockReservado, la deja RELEASED y emite stock.released', async () => {
      findOneAndUpdate.mockReturnValue(leanDe(reserva()));

      await service.release(cancelado());

      expect(findOneAndUpdate).toHaveBeenCalledWith(
        { orderId: 'order-1', status: 'RESERVED' },
        { $set: { status: 'RELEASED' } },
        { session },
      );
      // Liberar nunca toca `stock`, solo `stockReservado`.
      expect(updateOne).toHaveBeenCalledWith(
        { _id: new Types.ObjectId(V1) },
        { $inc: { stockReservado: -4 } },
        { session },
      );
      expect(updateOne).toHaveBeenCalledWith(
        { _id: new Types.ObjectId(V2) },
        { $inc: { stockReservado: -2 } },
        { session },
      );
      expect(emit).toHaveBeenCalledTimes(1);
      const [nombre, sobre] = emit.mock.calls[0];
      expect(nombre).toBe('stock.released');
      expect(sobre).toMatchObject({
        type: 'stock.released',
        correlationId: 'order-1',
        payload: {
          orderId: 'order-1',
          items: [
            { variantId: V1, cantidad: 4 },
            { variantId: V2, cantidad: 2 },
          ],
        },
      });
      expect(sobre.eventId).toEqual(expect.any(String));
      expect(Date.parse(sobre.occurredAt)).not.toBeNaN();
    });

    it('sobre una reserva REJECTED, CONFIRMED, RELEASED o inexistente no libera ni emite', async () => {
      // La transición condicional (solo desde RESERVED) no encuentra nada.
      findOneAndUpdate.mockReturnValue(leanDe(null));

      await service.release(cancelado());

      expect(updateOne).not.toHaveBeenCalled();
      expect(emit).not.toHaveBeenCalled();
    });

    it('una doble cancelación no libera dos veces', async () => {
      findOneAndUpdate
        .mockReturnValueOnce(leanDe(reserva()))
        .mockReturnValueOnce(leanDe(null));

      await service.release(cancelado());
      await service.release(cancelado());

      expect(updateOne).toHaveBeenCalledTimes(2);
      expect(emit).toHaveBeenCalledTimes(1);
    });

    it('cancelar tras confirmar no libera nada', async () => {
      findOneAndUpdate
        .mockReturnValueOnce(leanDe(reserva()))
        .mockReturnValueOnce(leanDe(null));

      await service.confirm(confirmado());
      updateOne.mockClear();
      await service.release(cancelado());

      expect(updateOne).not.toHaveBeenCalled();
      expect(emit).not.toHaveBeenCalled();
    });
  });
});

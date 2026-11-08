import { Types } from 'mongoose';
import { OrderQueryService } from '../services/order-query.service.js';

const BUYER = 'b1'.repeat(12);
const ORDER_ID = new Types.ObjectId();

const lean = <T>(value: T) => ({ lean: () => Promise.resolve(value) });

describe('OrderQueryService.getOrderForPayment', () => {
  const orderModel = { findOne: vi.fn() };
  let service: OrderQueryService;

  beforeEach(() => {
    vi.resetAllMocks();
    service = new OrderQueryService(orderModel as never);
  });

  it('devuelve total, moneda, status y expiresAt', async () => {
    const expiresAt = new Date('2026-11-08T12:15:00.000Z');
    orderModel.findOne.mockReturnValue(
      lean({
        _id: ORDER_ID,
        buyerId: new Types.ObjectId(BUYER),
        total: 4500,
        moneda: 'COP',
        status: 'AWAITING_PAYMENT',
        expiresAt,
      }),
    );

    const result = await service.getOrderForPayment(ORDER_ID.toString(), BUYER);

    expect(orderModel.findOne).toHaveBeenCalledWith({
      _id: ORDER_ID.toString(),
      buyerId: BUYER,
    });
    expect(result).toEqual({
      orderId: ORDER_ID.toString(),
      buyerId: BUYER,
      total: 4500,
      moneda: 'COP',
      status: 'AWAITING_PAYMENT',
      expiresAt,
    });
  });

  it('expiresAt es null mientras el pedido no espera pago', async () => {
    orderModel.findOne.mockReturnValue(
      lean({
        _id: ORDER_ID,
        buyerId: new Types.ObjectId(BUYER),
        total: 4500,
        moneda: 'COP',
        status: 'PENDING',
      }),
    );

    const result = await service.getOrderForPayment(ORDER_ID.toString(), BUYER);

    expect(result?.expiresAt).toBeNull();
  });

  it('null si el pedido no existe o es de otro comprador', async () => {
    orderModel.findOne.mockReturnValue(lean(null));

    await expect(
      service.getOrderForPayment(ORDER_ID.toString(), BUYER),
    ).resolves.toBeNull();
  });

  it('null, sin consultar Mongo, si algún id no es un ObjectId', async () => {
    await expect(
      service.getOrderForPayment('{"$ne": null}', BUYER),
    ).resolves.toBeNull();
    await expect(
      service.getOrderForPayment(ORDER_ID.toString(), 'abc'),
    ).resolves.toBeNull();
    expect(orderModel.findOne).not.toHaveBeenCalled();
  });
});

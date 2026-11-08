import { model, Types } from 'mongoose';
import { CartItemSchema } from '../schemas/cart-item.schema.js';
import { CartSchema } from '../schemas/cart.schema.js';
import { OrderItemSchema } from '../schemas/order-item.schema.js';
import { OrderSchema } from '../schemas/order.schema.js';
import { OutboxEventSchema } from '../schemas/outbox-event.schema.js';
import { OrderProcessedEventSchema } from '../schemas/processed-event.schema.js';
import { SubOrderSchema } from '../schemas/sub-order.schema.js';

type Indice = [Record<string, number>, Record<string, unknown>];
const indices = (schema: { indexes(): unknown[] }) =>
  schema.indexes() as Indice[];

const CartModel = model('CartSpec', CartSchema);
const CartItemModel = model('CartItemSpec', CartItemSchema);
const OrderModel = model('OrderSpec', OrderSchema);
const OutboxModel = model('OutboxSpec', OutboxEventSchema);

const oid = () => new Types.ObjectId();

describe('referencias ObjectId', () => {
  // Con `type: Types.ObjectId` Mongoose las trata como Mixed y guarda strings.
  it.each([
    [CartSchema, 'buyerId'],
    [CartItemSchema, 'cartId'],
    [CartItemSchema, 'variantId'],
    [OrderSchema, 'buyerId'],
    [SubOrderSchema, 'orderId'],
    [SubOrderSchema, 'storeId'],
    [OrderItemSchema, 'orderId'],
    [OrderItemSchema, 'subOrderId'],
    [OrderItemSchema, 'variantId'],
    [OrderItemSchema, 'productId'],
  ] as const)('%s.%s es un ObjectId, no Mixed', (schema, campo) => {
    const tipo = (schema as { path(p: string): { instance: string } }).path(
      campo,
    );
    expect(tipo.instance).toBe('ObjectId');
  });

  it('castea un id en string a ObjectId al crear', () => {
    const doc = new CartItemModel({ variantId: oid().toString() });
    expect(doc.variantId).toBeInstanceOf(Types.ObjectId);
  });
});

describe('índices', () => {
  it.each([
    ['carts', CartSchema, { buyerId: 1 }, true],
    ['cart_items', CartItemSchema, { cartId: 1, variantId: 1 }, true],
    ['orders', OrderSchema, { buyerId: 1, idempotencyKey: 1 }, true],
    ['orders', OrderSchema, { buyerId: 1, createdAt: -1 }, false],
    ['orders', OrderSchema, { status: 1, expiresAt: 1 }, false],
    ['orders', OrderSchema, { status: 1, createdAt: 1 }, false],
    ['sub_orders', SubOrderSchema, { orderId: 1, storeId: 1 }, true],
    ['sub_orders', SubOrderSchema, { storeId: 1, createdAt: -1 }, false],
    ['order_items', OrderItemSchema, { orderId: 1 }, false],
    ['outbox_events', OutboxEventSchema, { eventId: 1 }, true],
    [
      'outbox_events',
      OutboxEventSchema,
      { status: 1, nextAttemptAt: 1 },
      false,
    ],
    ['order_processed_events', OrderProcessedEventSchema, { eventId: 1 }, true],
  ] as const)(
    '%s tiene el índice %j (único: %s)',
    (_coleccion, schema, campos, unico) => {
      expect(indices(schema)).toContainEqual([
        campos,
        unico ? expect.objectContaining({ unique: true }) : expect.anything(),
      ]);
    },
  );

  it('usa las colecciones indicadas', () => {
    expect(CartModel.collection.name).toBe('carts');
    expect(OrderModel.collection.name).toBe('orders');
    expect(OutboxModel.collection.name).toBe('outbox_events');
    expect(OrderProcessedEventSchema.get('collection')).toBe(
      'order_processed_events',
    );
  });
});

describe('defaults', () => {
  it('Order inicia PENDING en COP', () => {
    const doc = new OrderModel({
      buyerId: oid(),
      total: 100,
      idempotencyKey: 'clave-123',
    });
    expect(doc.status).toBe('PENDING');
    expect(doc.moneda).toBe('COP');
    expect(doc.expiresAt).toBeUndefined();
  });

  it('OutboxEvent inicia PENDING, 0 intentos y nextAttemptAt ahora', () => {
    const antes = Date.now();
    const doc = new OutboxModel({
      eventId: 'e1',
      type: 'order.created',
      correlationId: 'o1',
      payload: {},
    });
    expect(doc.status).toBe('PENDING');
    expect(doc.attempts).toBe(0);
    expect(doc.nextAttemptAt.getTime()).toBeGreaterThanOrEqual(antes);
    expect(doc.lockedUntil).toBeUndefined();
  });

  it('OutboxEvent rechaza un tipo que no es order.*', () => {
    const doc = new OutboxModel({
      eventId: 'e1',
      type: 'stock.reserved',
      correlationId: 'o1',
      payload: {},
    });
    expect(doc.validateSync()?.errors.type).toBeDefined();
  });

  it('CartItem rechaza cantidad 0 y 1001', () => {
    for (const cantidad of [0, 1001]) {
      const doc = new CartItemModel({
        cartId: oid(),
        variantId: oid(),
        cantidad,
      });
      expect(doc.validateSync()?.errors.cantidad).toBeDefined();
    }
  });
});

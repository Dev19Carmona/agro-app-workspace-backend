import {
  objectIdSchema,
  setCartItemSchema,
  variantIdParamSchema,
} from '../dto/cart.dto.js';
import { idempotencyKeySchema } from '../dto/checkout.dto.js';
import {
  adminOrdersQuerySchema,
  ordersQuerySchema,
  providerSubOrdersQuerySchema,
} from '../dto/order-query.dto.js';

const id = 'a'.repeat(24);
const ok = (r: { success: boolean }) => r.success;

describe('cart DTO', () => {
  it('acepta cantidad 1 y 1000', () => {
    expect(ok(setCartItemSchema.safeParse({ cantidad: 1 }))).toBe(true);
    expect(ok(setCartItemSchema.safeParse({ cantidad: 1000 }))).toBe(true);
  });

  it.each([0, 1001, -1, 1.5, '5'])('rechaza cantidad %j', (cantidad) => {
    expect(ok(setCartItemSchema.safeParse({ cantidad }))).toBe(false);
  });

  it('rechaza propiedades de más (p. ej. un precio del cliente)', () => {
    expect(ok(setCartItemSchema.safeParse({ cantidad: 2, precio: 1 }))).toBe(
      false,
    );
  });

  it('rechaza {"$ne": null} como cantidad', () => {
    expect(ok(setCartItemSchema.safeParse({ cantidad: { $ne: null } }))).toBe(
      false,
    );
  });

  it('valida el id de ruta como ObjectId de 24 hex', () => {
    expect(ok(variantIdParamSchema.safeParse(id))).toBe(true);
    expect(ok(objectIdSchema.safeParse('abc'))).toBe(false);
    expect(ok(objectIdSchema.safeParse({ $ne: null }))).toBe(false);
  });
});

describe('checkout DTO', () => {
  it('acepta una clave de 8 a 100 caracteres', () => {
    expect(ok(idempotencyKeySchema.safeParse('a'.repeat(8)))).toBe(true);
    expect(ok(idempotencyKeySchema.safeParse('a'.repeat(100)))).toBe(true);
  });

  it('rechaza claves cortas, largas o que no son string', () => {
    expect(ok(idempotencyKeySchema.safeParse('a'.repeat(7)))).toBe(false);
    expect(ok(idempotencyKeySchema.safeParse('a'.repeat(101)))).toBe(false);
    expect(ok(idempotencyKeySchema.safeParse(undefined))).toBe(false);
    expect(ok(idempotencyKeySchema.safeParse({ $ne: null }))).toBe(false);
  });
});

describe('order-query DTO', () => {
  it('aplica page 1 y limit 20 por defecto', () => {
    const r = ordersQuerySchema.parse({});
    expect(r.page).toBe(1);
    expect(r.limit).toBe(20);
  });

  it('rechaza limit 101 y acepta 100 en los tres esquemas', () => {
    for (const schema of [
      ordersQuerySchema,
      providerSubOrdersQuerySchema,
      adminOrdersQuerySchema,
    ]) {
      expect(ok(schema.safeParse({ limit: '101' }))).toBe(false);
      expect(ok(schema.safeParse({ limit: '100' }))).toBe(true);
    }
  });

  it('rechaza page 0', () => {
    expect(ok(ordersQuerySchema.safeParse({ page: '0' }))).toBe(false);
  });

  it('valida status', () => {
    expect(ok(ordersQuerySchema.safeParse({ status: 'CONFIRMED' }))).toBe(true);
    expect(ok(ordersQuerySchema.safeParse({ status: 'PAID' }))).toBe(false);
    expect(ok(ordersQuerySchema.safeParse({ status: { $ne: null } }))).toBe(
      false,
    );
  });

  it('rechaza propiedades desconocidas', () => {
    expect(ok(ordersQuerySchema.safeParse({ buyerId: id }))).toBe(false);
    expect(
      ok(providerSubOrdersQuerySchema.safeParse({ status: 'CONFIRMED' })),
    ).toBe(false);
  });

  it('el ADMIN filtra por status y buyerId, y buyerId debe ser ObjectId', () => {
    expect(
      ok(
        adminOrdersQuerySchema.safeParse({ status: 'CANCELLED', buyerId: id }),
      ),
    ).toBe(true);
    expect(ok(adminOrdersQuerySchema.safeParse({ buyerId: 'xyz' }))).toBe(
      false,
    );
    expect(
      ok(adminOrdersQuerySchema.safeParse({ buyerId: { $ne: null } })),
    ).toBe(false);
  });
});

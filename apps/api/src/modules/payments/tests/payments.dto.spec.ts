import {
  createPaymentSchema,
  idempotencyKeySchema,
  objectIdSchema,
} from '../dto/create-payment.dto.js';
import {
  adminPaymentsQuerySchema,
  paymentsQuerySchema,
} from '../dto/payment-query.dto.js';
import { webhookSchema } from '../dto/webhook.dto.js';

const id = 'a'.repeat(24);
const ok = (r: { success: boolean }) => r.success;
const body = { orderId: id, metodo: 'CARD', token: 'tok_test_approved' };

describe('create-payment DTO', () => {
  it.each(['CARD', 'PSE', 'NEQUI'])('acepta metodo %s', (metodo) => {
    expect(ok(createPaymentSchema.safeParse({ ...body, metodo }))).toBe(true);
  });

  it('acepta cualquier token de 1 a 100 caracteres', () => {
    expect(ok(createPaymentSchema.safeParse({ ...body, token: 'x' }))).toBe(true);
    expect(
      ok(createPaymentSchema.safeParse({ ...body, token: 'x'.repeat(100) })),
    ).toBe(true);
  });

  it.each(['', 'x'.repeat(101), 5, null, { $ne: null }])(
    'rechaza el token %j',
    (token) => {
      expect(ok(createPaymentSchema.safeParse({ ...body, token }))).toBe(false);
    },
  );

  it('rechaza un metodo desconocido', () => {
    expect(ok(createPaymentSchema.safeParse({ ...body, metodo: 'EFECTIVO' }))).toBe(
      false,
    );
  });

  it('rechaza propiedades de más (p. ej. un monto del cliente)', () => {
    expect(ok(createPaymentSchema.safeParse({ ...body, monto: 1 }))).toBe(false);
  });

  it('rechaza {"$ne": null} como orderId o como cuerpo', () => {
    expect(
      ok(createPaymentSchema.safeParse({ ...body, orderId: { $ne: null } })),
    ).toBe(false);
    expect(ok(createPaymentSchema.safeParse({ $ne: null }))).toBe(false);
  });

  it('rechaza si falta un campo', () => {
    for (const campo of ['orderId', 'metodo', 'token'] as const) {
      const { [campo]: _omitido, ...resto } = body;
      expect(ok(createPaymentSchema.safeParse(resto))).toBe(false);
    }
  });

  it('valida el id como ObjectId de 24 hex', () => {
    expect(ok(objectIdSchema.safeParse(id))).toBe(true);
    expect(ok(objectIdSchema.safeParse('abc'))).toBe(false);
    expect(ok(objectIdSchema.safeParse({ $ne: null }))).toBe(false);
  });
});

describe('Idempotency-Key', () => {
  it('acepta de 8 a 100 caracteres', () => {
    expect(ok(idempotencyKeySchema.safeParse('a'.repeat(8)))).toBe(true);
    expect(ok(idempotencyKeySchema.safeParse('a'.repeat(100)))).toBe(true);
  });

  it('rechaza claves cortas, largas, ausentes o que no son string', () => {
    expect(ok(idempotencyKeySchema.safeParse('a'.repeat(7)))).toBe(false);
    expect(ok(idempotencyKeySchema.safeParse('a'.repeat(101)))).toBe(false);
    expect(ok(idempotencyKeySchema.safeParse(undefined))).toBe(false);
    expect(ok(idempotencyKeySchema.safeParse({ $ne: null }))).toBe(false);
  });
});

describe('payment-query DTO', () => {
  it('aplica page 1 y limit 20 por defecto y convierte strings', () => {
    expect(paymentsQuerySchema.parse({})).toEqual({ page: 1, limit: 20 });
    expect(paymentsQuerySchema.parse({ page: '2', limit: '50' })).toEqual({
      page: 2,
      limit: 50,
    });
  });

  it('acepta limit 100 y rechaza 101, 0, page 0 y no numéricos', () => {
    expect(ok(paymentsQuerySchema.safeParse({ limit: '100' }))).toBe(true);
    expect(ok(paymentsQuerySchema.safeParse({ limit: '101' }))).toBe(false);
    expect(ok(paymentsQuerySchema.safeParse({ limit: '0' }))).toBe(false);
    expect(ok(paymentsQuerySchema.safeParse({ page: '0' }))).toBe(false);
    expect(ok(paymentsQuerySchema.safeParse({ page: 'x' }))).toBe(false);
  });

  it('filtra por status y orderId; rechaza valores desconocidos', () => {
    expect(
      ok(paymentsQuerySchema.safeParse({ status: 'APPROVED', orderId: id })),
    ).toBe(true);
    expect(ok(paymentsQuerySchema.safeParse({ status: 'OTRO' }))).toBe(false);
    expect(ok(paymentsQuerySchema.safeParse({ orderId: 'abc' }))).toBe(false);
  });

  it('el PRODUCTOR no puede filtrar por buyerId ni mandar otras propiedades', () => {
    expect(ok(paymentsQuerySchema.safeParse({ buyerId: id }))).toBe(false);
    expect(ok(paymentsQuerySchema.safeParse({ extra: 1 }))).toBe(false);
  });

  it('el ADMIN filtra por status, buyerId y orderId', () => {
    expect(
      ok(
        adminPaymentsQuerySchema.safeParse({
          status: 'DECLINED',
          buyerId: id,
          orderId: id,
        }),
      ),
    ).toBe(true);
    expect(ok(adminPaymentsQuerySchema.safeParse({ buyerId: 'abc' }))).toBe(false);
    expect(ok(adminPaymentsQuerySchema.safeParse({ limit: '101' }))).toBe(false);
  });

  it('rechaza {"$ne": null} en los filtros', () => {
    expect(
      ok(paymentsQuerySchema.safeParse({ status: { $ne: null } })),
    ).toBe(false);
    expect(
      ok(adminPaymentsQuerySchema.safeParse({ buyerId: { $ne: null } })),
    ).toBe(false);
  });
});

describe('webhook DTO', () => {
  const ev = {
    eventId: '3f2b8c1e-6a4d-4f0a-9b7e-1c2d3e4f5a6b',
    paymentId: id,
    resultado: 'APPROVED',
  };

  it.each(['APPROVED', 'DECLINED', 'ERROR'])('acepta resultado %s', (resultado) => {
    expect(ok(webhookSchema.safeParse({ ...ev, resultado }))).toBe(true);
  });

  it('acepta motivo de hasta 200 caracteres y rechaza 201', () => {
    expect(ok(webhookSchema.safeParse({ ...ev, motivo: 'm'.repeat(200) }))).toBe(true);
    expect(ok(webhookSchema.safeParse({ ...ev, motivo: 'm'.repeat(201) }))).toBe(false);
  });

  it('rechaza PROCESSING, eventId que no es uuid y paymentId inválido', () => {
    expect(ok(webhookSchema.safeParse({ ...ev, resultado: 'PROCESSING' }))).toBe(false);
    expect(ok(webhookSchema.safeParse({ ...ev, eventId: 'no-uuid' }))).toBe(false);
    expect(ok(webhookSchema.safeParse({ ...ev, paymentId: 'abc' }))).toBe(false);
  });

  it('rechaza propiedades de más y {"$ne": null}', () => {
    expect(ok(webhookSchema.safeParse({ ...ev, monto: 1 }))).toBe(false);
    expect(ok(webhookSchema.safeParse({ ...ev, paymentId: { $ne: null } }))).toBe(false);
  });
});

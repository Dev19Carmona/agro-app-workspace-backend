import {
  type CanActivate,
  type ExecutionContext,
  type INestApplication,
  NotFoundException,
  StandardSchemaValidationPipe,
} from '@nestjs/common';
import { APP_GUARD, APP_PIPE } from '@nestjs/core';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { RolesGuard } from '../../../../../../libs/common/src/security/roles.guard.js';
import { PaymentsController } from '../controllers/payments.controller.js';
import { PaymentsQueryService } from '../services/payments-query.service.js';
import { PaymentsService } from '../services/payments.service.js';

const USER_ID = '6aee7a351616d80ba08c95aa';
const KEY = 'clave-de-prueba-1';
const ORDER_ID = 'a1'.repeat(12);
const PAYMENT_ID = 'b2'.repeat(12);

/** Sustituye a `JwtAuthGuard`: el rol sale de la cabecera `x-test-rol`. */
class FakeAuthGuard implements CanActivate {
  canActivate(context: ExecutionContext): boolean {
    const req = context.switchToHttp().getRequest();
    req.user = {
      id: USER_ID,
      rol: req.headers['x-test-rol'] ?? 'PRODUCTOR',
      sessionId: 'fam-1',
    };
    return true;
  }
}

const guardado = (extra: Record<string, unknown> = {}) => ({
  _id: PAYMENT_ID,
  orderId: ORDER_ID,
  buyerId: USER_ID,
  monto: 75000,
  moneda: 'COP',
  metodo: 'CARD',
  status: 'APPROVED',
  referencia: 'SIM-1',
  idempotencyKey: KEY,
  requestHash: 'secreto-interno',
  eventId: 'e-1',
  eventAttempts: 0,
  createdAt: new Date('2026-11-08T12:00:00.000Z'),
  ...extra,
});

const body = { orderId: ORDER_ID, metodo: 'CARD', token: 'tok_test_approved' };

describe('PaymentsController (HTTP con pipe y RolesGuard reales)', () => {
  const payments = { create: vi.fn() };
  const queries = { listMine: vi.fn(), getMine: vi.fn() };
  let app: INestApplication;
  const post = () => request(app.getHttpServer()).post('/payments');

  beforeEach(async () => {
    vi.resetAllMocks();
    const moduleRef = await Test.createTestingModule({
      controllers: [PaymentsController],
      providers: [
        { provide: PaymentsService, useValue: payments },
        { provide: PaymentsQueryService, useValue: queries },
        { provide: APP_PIPE, useClass: StandardSchemaValidationPipe },
        { provide: APP_GUARD, useClass: FakeAuthGuard },
        { provide: APP_GUARD, useClass: RolesGuard },
      ],
    }).compile();
    app = moduleRef.createNestApplication();
    await app.init();
  });

  afterEach(async () => {
    await app.close();
  });

  it('201 en el primer intento, con la vista pública del pago', async () => {
    payments.create.mockResolvedValue({ payment: guardado(), replay: false });

    const res = await post().set('Idempotency-Key', KEY).send(body);

    expect(res.status).toBe(201);
    expect(payments.create).toHaveBeenCalledWith(USER_ID, KEY, body);
    expect(res.body).toEqual({
      id: PAYMENT_ID,
      orderId: ORDER_ID,
      monto: 75000,
      moneda: 'COP',
      metodo: 'CARD',
      status: 'APPROVED',
      referencia: 'SIM-1',
      createdAt: '2026-11-08T12:00:00.000Z',
    });
  });

  it('la respuesta nunca incluye idempotencyKey, requestHash ni token', async () => {
    payments.create.mockResolvedValue({ payment: guardado(), replay: false });

    const res = await post().set('Idempotency-Key', KEY).send(body);

    const texto = JSON.stringify(res.body);
    expect(texto).not.toContain('idempotencyKey');
    expect(texto).not.toContain('requestHash');
    expect(texto).not.toContain('secreto-interno');
    expect(texto).not.toContain('tok_test');
    expect(texto).not.toContain('eventId');
  });

  it('200 en un reintento con la misma clave', async () => {
    payments.create.mockResolvedValue({ payment: guardado(), replay: true });

    const res = await post().set('Idempotency-Key', KEY).send(body);

    expect(res.status).toBe(200);
  });

  it('un pago DECLINED también responde 201 con el resultado en status', async () => {
    payments.create.mockResolvedValue({
      payment: guardado({ status: 'DECLINED', motivoRechazo: 'INSUFFICIENT_FUNDS' }),
      replay: false,
    });

    const res = await post().set('Idempotency-Key', KEY).send(body);

    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({
      status: 'DECLINED',
      motivoRechazo: 'INSUFFICIENT_FUNDS',
    });
  });

  it.each([undefined, 'corta', 'x'.repeat(101)])(
    'responde 400 con Idempotency-Key %j',
    async (key) => {
      const req = post();
      if (key !== undefined) req.set('Idempotency-Key', key);
      const res = await req.send(body);

      expect(res.status).toBe(400);
      expect(payments.create).not.toHaveBeenCalled();
    },
  );

  it.each([
    ['propiedad de más', { ...body, extra: 1 }],
    ['monto del cliente', { ...body, monto: 1 }],
    ['metodo desconocido', { ...body, metodo: 'EFECTIVO' }],
    ['{"$ne": null} como orderId', { ...body, orderId: { $ne: null } }],
    ['{"$ne": null} como cuerpo', { $ne: null }],
    ['sin token', { orderId: ORDER_ID, metodo: 'CARD' }],
    ['orderId inválido', { ...body, orderId: 'abc' }],
  ])('responde 400 con %s', async (_n, cuerpo) => {
    const res = await post().set('Idempotency-Key', KEY).send(cuerpo);

    expect(res.status).toBe(400);
    expect(payments.create).not.toHaveBeenCalled();
  });

  it.each(['PROVEEDOR', 'ADMIN'])('responde 403 a %s', async (rol) => {
    const res = await post()
      .set('x-test-rol', rol)
      .set('Idempotency-Key', KEY)
      .send(body);

    expect(res.status).toBe(403);
    expect(payments.create).not.toHaveBeenCalled();
  });

  describe('GET /payments', () => {
    const get = (url: string) => request(app.getHttpServer()).get(url);

    it('lista los pagos del usuario del token con limit 20 por defecto', async () => {
      queries.listMine.mockResolvedValue({ data: [], page: 1, limit: 20, total: 0 });

      const res = await get('/payments');

      expect(res.status).toBe(200);
      expect(queries.listMine).toHaveBeenCalledWith(USER_ID, {
        page: 1,
        limit: 20,
      });
    });

    it('acepta page, limit, status y orderId', async () => {
      queries.listMine.mockResolvedValue({ data: [] });

      await get(`/payments?page=2&limit=100&status=DECLINED&orderId=${ORDER_ID}`);

      expect(queries.listMine).toHaveBeenCalledWith(USER_ID, {
        page: 2,
        limit: 100,
        status: 'DECLINED',
        orderId: ORDER_ID,
      });
    });

    it.each([
      'limit=101',
      'page=0',
      'status=PAID',
      'orderId=abc',
      `buyerId=${'a'.repeat(24)}`,
    ])('rechaza ?%s con 400', async (qs) => {
      const res = await get(`/payments?${qs}`);

      expect(res.status).toBe(400);
      expect(queries.listMine).not.toHaveBeenCalled();
    });

    it.each(['PROVEEDOR', 'ADMIN'])('responde 403 a %s', async (rol) => {
      const res = await get('/payments').set('x-test-rol', rol);

      expect(res.status).toBe(403);
      expect(queries.listMine).not.toHaveBeenCalled();
    });
  });

  describe('GET /payments/:id', () => {
    const get = (url: string) => request(app.getHttpServer()).get(url);

    it('devuelve el pago propio', async () => {
      queries.getMine.mockResolvedValue({ id: PAYMENT_ID });

      const res = await get(`/payments/${PAYMENT_ID}`);

      expect(res.status).toBe(200);
      expect(queries.getMine).toHaveBeenCalledWith(USER_ID, PAYMENT_ID);
    });

    it('un pago ajeno responde 404', async () => {
      queries.getMine.mockRejectedValue(new NotFoundException('Pago no encontrado'));

      const res = await get(`/payments/${PAYMENT_ID}`);

      expect(res.status).toBe(404);
    });

    it('rechaza un id que no es ObjectId con 400', async () => {
      const res = await get('/payments/abc');

      expect(res.status).toBe(400);
      expect(queries.getMine).not.toHaveBeenCalled();
    });

    it.each(['PROVEEDOR', 'ADMIN'])('responde 403 a %s', async (rol) => {
      const res = await get(`/payments/${PAYMENT_ID}`).set('x-test-rol', rol);

      expect(res.status).toBe(403);
      expect(queries.getMine).not.toHaveBeenCalled();
    });
  });
});

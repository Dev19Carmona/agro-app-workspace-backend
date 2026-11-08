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
import { PaymentsAdminController } from '../controllers/payments-admin.controller.js';
import { PaymentsController } from '../controllers/payments.controller.js';
import { PaymentsQueryService } from '../services/payments-query.service.js';
import { PaymentsService } from '../services/payments.service.js';

const ID = 'a1'.repeat(12);
const BUYER = 'b2'.repeat(12);

/** Sustituye a `JwtAuthGuard`: el rol sale de la cabecera `x-test-rol`. */
class FakeAuthGuard implements CanActivate {
  canActivate(context: ExecutionContext): boolean {
    const req = context.switchToHttp().getRequest();
    req.user = {
      id: '6aee7a351616d80ba08c95aa',
      rol: req.headers['x-test-rol'] ?? 'ADMIN',
      sessionId: 'fam-1',
    };
    return true;
  }
}

describe('PaymentsAdminController (HTTP con pipe y RolesGuard reales)', () => {
  const queries = { listAdmin: vi.fn(), getAdmin: vi.fn(), listMine: vi.fn(), getMine: vi.fn() };
  const payments = { create: vi.fn() };
  let app: INestApplication;
  const get = (url: string) => request(app.getHttpServer()).get(url);

  beforeEach(async () => {
    vi.resetAllMocks();
    const moduleRef = await Test.createTestingModule({
      // Mismo orden que `PaymentsModule`: `admin` antes de `:id`.
      controllers: [PaymentsAdminController, PaymentsController],
      providers: [
        { provide: PaymentsQueryService, useValue: queries },
        { provide: PaymentsService, useValue: payments },
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

  describe('GET /payments/admin', () => {
    it('lista con limit 20 por defecto', async () => {
      queries.listAdmin.mockResolvedValue({ data: [], page: 1, limit: 20, total: 0 });

      const res = await get('/payments/admin');

      expect(res.status).toBe(200);
      expect(queries.listAdmin).toHaveBeenCalledWith({ page: 1, limit: 20 });
    });

    it('acepta los filtros status, buyerId y orderId', async () => {
      queries.listAdmin.mockResolvedValue({ data: [] });

      await get(
        `/payments/admin?status=APPROVED&buyerId=${BUYER}&orderId=${ID}&page=2&limit=100`,
      );

      expect(queries.listAdmin).toHaveBeenCalledWith({
        page: 2,
        limit: 100,
        status: 'APPROVED',
        buyerId: BUYER,
        orderId: ID,
      });
    });

    it.each(['limit=101', 'page=0', 'status=PAID', 'buyerId=abc', 'orderId=abc', 'x=1'])(
      'rechaza ?%s con 400',
      async (qs) => {
        const res = await get(`/payments/admin?${qs}`);

        expect(res.status).toBe(400);
        expect(queries.listAdmin).not.toHaveBeenCalled();
      },
    );

    it.each(['PRODUCTOR', 'PROVEEDOR'])('responde 403 a %s', async (rol) => {
      const res = await get('/payments/admin').set('x-test-rol', rol);

      expect(res.status).toBe(403);
      expect(queries.listAdmin).not.toHaveBeenCalled();
    });

    it('`admin` no lo captura GET /payments/:id', async () => {
      queries.listAdmin.mockResolvedValue({ data: [] });

      const res = await get('/payments/admin');

      expect(res.status).toBe(200);
      expect(queries.getMine).not.toHaveBeenCalled();
    });
  });

  describe('GET /payments/admin/:id', () => {
    it('devuelve el detalle con intentos', async () => {
      queries.getAdmin.mockResolvedValue({ id: ID, attempts: [] });

      const res = await get(`/payments/admin/${ID}`);

      expect(res.status).toBe(200);
      expect(res.body).toEqual({ id: ID, attempts: [] });
      expect(queries.getAdmin).toHaveBeenCalledWith(ID);
    });

    it('pago inexistente: 404', async () => {
      queries.getAdmin.mockRejectedValue(new NotFoundException('Pago no encontrado'));

      const res = await get(`/payments/admin/${ID}`);

      expect(res.status).toBe(404);
    });

    it('id que no es ObjectId: 400', async () => {
      const res = await get('/payments/admin/abc');

      expect(res.status).toBe(400);
      expect(queries.getAdmin).not.toHaveBeenCalled();
    });

    it.each(['PRODUCTOR', 'PROVEEDOR'])('responde 403 a %s', async (rol) => {
      const res = await get(`/payments/admin/${ID}`).set('x-test-rol', rol);

      expect(res.status).toBe(403);
      expect(queries.getAdmin).not.toHaveBeenCalled();
    });
  });

  describe('solo lectura', () => {
    it.each(['post', 'put', 'patch', 'delete'] as const)(
      '%s /payments/admin/:id no existe (404)',
      async (metodo) => {
        const res = await request(app.getHttpServer())[metodo](`/payments/admin/${ID}`);

        expect(res.status).toBe(404);
      },
    );

    it('ADMIN no puede crear pagos: 403 en POST /payments', async () => {
      const res = await request(app.getHttpServer())
        .post('/payments')
        .set('Idempotency-Key', 'clave-de-prueba-1')
        .send({ orderId: ID, metodo: 'CARD', token: 'tok_test_approved' });

      expect(res.status).toBe(403);
      expect(payments.create).not.toHaveBeenCalled();
    });
  });
});

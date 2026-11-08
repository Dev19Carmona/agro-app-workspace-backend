import {
  type CanActivate,
  type ExecutionContext,
  type INestApplication,
  StandardSchemaValidationPipe,
} from '@nestjs/common';
import { APP_GUARD, APP_PIPE } from '@nestjs/core';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { RolesGuard } from '../../../../../../libs/common/src/security/roles.guard.js';
import { CartController } from '../controllers/cart.controller.js';
import { OrdersAdminController } from '../controllers/orders-admin.controller.js';
import { OrdersController } from '../controllers/orders.controller.js';
import { CartService } from '../services/cart.service.js';
import { CheckoutService } from '../services/checkout.service.js';
import { OrdersService } from '../services/orders.service.js';

const USER_ID = '6aee7a351616d80ba08c95aa';
const ID = 'a1'.repeat(12);
const BUYER = 'b1'.repeat(12);

/** Sustituye a `JwtAuthGuard`: el rol sale de la cabecera `x-test-rol`. */
class FakeAuthGuard implements CanActivate {
  canActivate(context: ExecutionContext): boolean {
    const req = context.switchToHttp().getRequest();
    req.user = {
      id: USER_ID,
      rol: req.headers['x-test-rol'] ?? 'ADMIN',
      sessionId: 'fam-1',
    };
    return true;
  }
}

describe('OrdersAdminController (HTTP con pipe y RolesGuard reales)', () => {
  const orders = { listAll: vi.fn(), getAny: vi.fn(), getMine: vi.fn() };
  let app: INestApplication;
  const http = () => request(app.getHttpServer());

  beforeEach(async () => {
    vi.resetAllMocks();
    const moduleRef = await Test.createTestingModule({
      // Mismo orden que `OrderModule`: las rutas fijas antes de `:id`.
      controllers: [CartController, OrdersAdminController, OrdersController],
      providers: [
        { provide: OrdersService, useValue: orders },
        { provide: CartService, useValue: {} },
        { provide: CheckoutService, useValue: {} },
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

  describe('GET /orders/admin', () => {
    it('lista todos los pedidos con limit 20 por defecto', async () => {
      orders.listAll.mockResolvedValue({
        data: [],
        page: 1,
        limit: 20,
        total: 0,
      });

      const res = await http().get('/orders/admin');

      expect(res.status).toBe(200);
      expect(orders.listAll).toHaveBeenCalledWith({ page: 1, limit: 20 });
      expect(orders.getMine).not.toHaveBeenCalled();
    });

    it('acepta los filtros status y buyerId', async () => {
      orders.listAll.mockResolvedValue({ data: [] });

      await http().get(`/orders/admin?status=CONFIRMED&buyerId=${BUYER}`);

      expect(orders.listAll).toHaveBeenCalledWith({
        page: 1,
        limit: 20,
        status: 'CONFIRMED',
        buyerId: BUYER,
      });
    });

    it.each(['limit=101', 'status=PAID', 'buyerId=abc'])(
      'rechaza ?%s con 400',
      async (qs) => {
        const res = await http().get(`/orders/admin?${qs}`);

        expect(res.status).toBe(400);
        expect(orders.listAll).not.toHaveBeenCalled();
      },
    );

    it.each(['PRODUCTOR', 'PROVEEDOR'])('responde 403 a %s', async (rol) => {
      const res = await http().get('/orders/admin').set('x-test-rol', rol);

      expect(res.status).toBe(403);
      expect(orders.listAll).not.toHaveBeenCalled();
    });
  });

  describe('GET /orders/admin/:id', () => {
    it('devuelve el detalle de cualquier pedido', async () => {
      orders.getAny.mockResolvedValue({ id: ID });

      const res = await http().get(`/orders/admin/${ID}`);

      expect(res.status).toBe(200);
      expect(orders.getAny).toHaveBeenCalledWith(ID);
    });

    it('rechaza un id inválido con 400', async () => {
      const res = await http().get('/orders/admin/abc');

      expect(res.status).toBe(400);
      expect(orders.getAny).not.toHaveBeenCalled();
    });

    it.each(['PRODUCTOR', 'PROVEEDOR'])('responde 403 a %s', async (rol) => {
      const res = await http()
        .get(`/orders/admin/${ID}`)
        .set('x-test-rol', rol);

      expect(res.status).toBe(403);
    });
  });

  it('ADMIN no tiene endpoints que modifiquen pedidos: POST, PUT, PATCH y DELETE dan 403 o 404', async () => {
    const rutas = [
      () => http().post(`/orders/admin/${ID}`),
      () => http().put(`/orders/admin/${ID}`),
      () => http().patch(`/orders/admin/${ID}`),
      () => http().delete(`/orders/admin/${ID}`),
      () => http().post('/orders/checkout'),
      () => http().put(`/orders/cart/items/${ID}`).send({ cantidad: 1 }),
      () => http().delete('/orders/cart'),
    ];
    for (const ruta of rutas) {
      const res = await ruta();
      expect([403, 404]).toContain(res.status);
    }
  });
});

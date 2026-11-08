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
import { OrdersController } from '../controllers/orders.controller.js';
import { CartService } from '../services/cart.service.js';
import { CheckoutService } from '../services/checkout.service.js';
import { OrdersService } from '../services/orders.service.js';

const USER_ID = '6aee7a351616d80ba08c95aa';
const KEY = 'clave-de-prueba-1';

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

describe('OrdersController (HTTP con pipe y RolesGuard reales)', () => {
  const checkout = { checkout: vi.fn() };
  const orders = { listMine: vi.fn(), getMine: vi.fn() };
  const cart = { get: vi.fn() };
  const ID = 'a1'.repeat(12);
  let app: INestApplication;
  const http = () => request(app.getHttpServer());

  beforeEach(async () => {
    vi.resetAllMocks();
    const moduleRef = await Test.createTestingModule({
      // Mismo orden que `OrderModule`: las rutas fijas antes de `:id`.
      controllers: [CartController, OrdersController],
      providers: [
        { provide: CheckoutService, useValue: checkout },
        { provide: OrdersService, useValue: orders },
        { provide: CartService, useValue: cart },
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

  describe('GET /orders', () => {
    it('lista los pedidos del usuario del token con limit 20 por defecto', async () => {
      orders.listMine.mockResolvedValue({
        data: [],
        page: 1,
        limit: 20,
        total: 0,
      });

      const res = await http().get('/orders');

      expect(res.status).toBe(200);
      expect(orders.listMine).toHaveBeenCalledWith(USER_ID, {
        page: 1,
        limit: 20,
      });
    });

    it('acepta page, limit y status', async () => {
      orders.listMine.mockResolvedValue({ data: [] });

      await http().get('/orders?page=2&limit=100&status=CONFIRMED');

      expect(orders.listMine).toHaveBeenCalledWith(USER_ID, {
        page: 2,
        limit: 100,
        status: 'CONFIRMED',
      });
    });

    it.each([
      'limit=101',
      'page=0',
      'status=PAID',
      'buyerId=' + 'a'.repeat(24),
    ])('rechaza ?%s con 400', async (qs) => {
      const res = await http().get(`/orders?${qs}`);

      expect(res.status).toBe(400);
      expect(orders.listMine).not.toHaveBeenCalled();
    });

    it.each(['PROVEEDOR', 'ADMIN'])('responde 403 a %s', async (rol) => {
      const res = await http().get('/orders').set('x-test-rol', rol);

      expect(res.status).toBe(403);
      expect(orders.listMine).not.toHaveBeenCalled();
    });
  });

  describe('GET /orders/:id', () => {
    it('devuelve el pedido propio', async () => {
      orders.getMine.mockResolvedValue({ id: ID });

      const res = await http().get(`/orders/${ID}`);

      expect(res.status).toBe(200);
      expect(orders.getMine).toHaveBeenCalledWith(USER_ID, ID);
    });

    it('un pedido ajeno da 404 (lo decide el servicio)', async () => {
      const { NotFoundException } = await import('@nestjs/common');
      orders.getMine.mockRejectedValue(new NotFoundException());

      const res = await http().get(`/orders/${ID}`);

      expect(res.status).toBe(404);
    });

    it('rechaza un id que no es ObjectId con 400', async () => {
      const res = await http().get('/orders/abc');

      expect(res.status).toBe(400);
      expect(orders.getMine).not.toHaveBeenCalled();
    });

    it('responde 403 a un PROVEEDOR', async () => {
      const res = await http()
        .get(`/orders/${ID}`)
        .set('x-test-rol', 'PROVEEDOR');

      expect(res.status).toBe(403);
    });

    it('GET /orders/cart no lo captura :id: llega al carrito', async () => {
      cart.get.mockResolvedValue({ items: [], total: 0 });

      const res = await http().get('/orders/cart');

      expect(res.status).toBe(200);
      expect(cart.get).toHaveBeenCalledWith(USER_ID);
      expect(orders.getMine).not.toHaveBeenCalled();
    });
  });

  describe('POST /orders/checkout', () => {
    it('responde 201 con el pedido PENDING y usa el id del token', async () => {
      checkout.checkout.mockResolvedValue({
        order: { id: 'o1', status: 'PENDING', total: 2000, moneda: 'COP' },
        created: true,
      });

      const res = await http()
        .post('/orders/checkout')
        .set('Idempotency-Key', KEY);

      expect(res.status).toBe(201);
      expect(res.body).toMatchObject({ id: 'o1', status: 'PENDING' });
      expect(checkout.checkout).toHaveBeenCalledWith(USER_ID, KEY);
    });

    it('responde 200 con el mismo pedido si la clave se repite', async () => {
      checkout.checkout.mockResolvedValue({
        order: { id: 'o1', status: 'PENDING' },
        created: false,
      });

      const res = await http()
        .post('/orders/checkout')
        .set('Idempotency-Key', KEY);

      expect(res.status).toBe(200);
      expect(res.body.id).toBe('o1');
    });

    it('responde 400 sin Idempotency-Key', async () => {
      const res = await http().post('/orders/checkout');

      expect(res.status).toBe(400);
      expect(checkout.checkout).not.toHaveBeenCalled();
    });

    it.each(['corta', 'x'.repeat(101)])(
      'responde 400 con una Idempotency-Key de %s caracteres',
      async (key) => {
        const res = await http()
          .post('/orders/checkout')
          .set('Idempotency-Key', key);

        expect(res.status).toBe(400);
        expect(checkout.checkout).not.toHaveBeenCalled();
      },
    );

    it.each(['PROVEEDOR', 'ADMIN'])('responde 403 a %s', async (rol) => {
      const res = await http()
        .post('/orders/checkout')
        .set('x-test-rol', rol)
        .set('Idempotency-Key', KEY);

      expect(res.status).toBe(403);
      expect(checkout.checkout).not.toHaveBeenCalled();
    });
  });
});

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
import { OrdersController } from '../controllers/orders.controller.js';
import { CheckoutService } from '../services/checkout.service.js';

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
  let app: INestApplication;
  const http = () => request(app.getHttpServer());

  beforeEach(async () => {
    vi.resetAllMocks();
    const moduleRef = await Test.createTestingModule({
      controllers: [OrdersController],
      providers: [
        { provide: CheckoutService, useValue: checkout },
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

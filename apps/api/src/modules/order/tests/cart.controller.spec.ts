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
import { CartService } from '../services/cart.service.js';

const USER_ID = '6aee7a351616d80ba08c95aa';
const VARIANT = 'b'.repeat(24);

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

describe('CartController (HTTP con pipe y RolesGuard reales)', () => {
  const cart = {
    get: vi.fn(),
    setItem: vi.fn(),
    removeItem: vi.fn(),
    clear: vi.fn(),
  };
  let app: INestApplication;
  const http = () => request(app.getHttpServer());

  beforeEach(async () => {
    vi.resetAllMocks();
    const moduleRef = await Test.createTestingModule({
      controllers: [CartController],
      providers: [
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

  describe('GET /orders/cart', () => {
    it('devuelve el carrito del usuario autenticado', async () => {
      cart.get.mockResolvedValue({ items: [], total: 0 });

      const res = await http().get('/orders/cart');

      expect(res.status).toBe(200);
      expect(res.body).toEqual({ items: [], total: 0 });
      expect(cart.get).toHaveBeenCalledWith(USER_ID);
    });

    it.each(['PROVEEDOR', 'ADMIN'])('responde 403 a %s', async (rol) => {
      const res = await http().get('/orders/cart').set('x-test-rol', rol);

      expect(res.status).toBe(403);
      expect(cart.get).not.toHaveBeenCalled();
    });
  });

  describe('PUT /orders/cart/items/:variantId', () => {
    it('fija la cantidad con el id del token', async () => {
      cart.setItem.mockResolvedValue({ variantId: VARIANT, cantidad: 3 });

      const res = await http()
        .put(`/orders/cart/items/${VARIANT}`)
        .send({ cantidad: 3 });

      expect(res.status).toBe(200);
      expect(res.body).toEqual({ variantId: VARIANT, cantidad: 3 });
      expect(cart.setItem).toHaveBeenCalledWith(USER_ID, VARIANT, 3);
    });

    it.each([0, 1001])('rechaza cantidad %i con 400', async (cantidad) => {
      const res = await http()
        .put(`/orders/cart/items/${VARIANT}`)
        .send({ cantidad });

      expect(res.status).toBe(400);
      expect(cart.setItem).not.toHaveBeenCalled();
    });

    it('rechaza una propiedad de más (precio) con 400', async () => {
      const res = await http()
        .put(`/orders/cart/items/${VARIANT}`)
        .send({ cantidad: 1, precio: 1 });

      expect(res.status).toBe(400);
      expect(cart.setItem).not.toHaveBeenCalled();
    });

    it('rechaza un operador {"$ne": null} con 400', async () => {
      const res = await http()
        .put(`/orders/cart/items/${VARIANT}`)
        .send({ cantidad: { $ne: null } });

      expect(res.status).toBe(400);
      expect(cart.setItem).not.toHaveBeenCalled();
    });

    it('rechaza un id que no es ObjectId con 400', async () => {
      const res = await http()
        .put('/orders/cart/items/abc')
        .send({ cantidad: 1 });

      expect(res.status).toBe(400);
      expect(cart.setItem).not.toHaveBeenCalled();
    });

    it.each(['PROVEEDOR', 'ADMIN'])('responde 403 a %s', async (rol) => {
      const res = await http()
        .put(`/orders/cart/items/${VARIANT}`)
        .set('x-test-rol', rol)
        .send({ cantidad: 1 });

      expect(res.status).toBe(403);
      expect(cart.setItem).not.toHaveBeenCalled();
    });
  });

  describe('DELETE /orders/cart/items/:variantId', () => {
    it('responde 204 y quita la línea', async () => {
      cart.removeItem.mockResolvedValue(undefined);

      const res = await http().delete(`/orders/cart/items/${VARIANT}`);

      expect(res.status).toBe(204);
      expect(cart.removeItem).toHaveBeenCalledWith(USER_ID, VARIANT);
    });

    it('rechaza un id inválido con 400', async () => {
      const res = await http().delete('/orders/cart/items/abc');

      expect(res.status).toBe(400);
      expect(cart.removeItem).not.toHaveBeenCalled();
    });

    it.each(['PROVEEDOR', 'ADMIN'])('responde 403 a %s', async (rol) => {
      const res = await http()
        .delete(`/orders/cart/items/${VARIANT}`)
        .set('x-test-rol', rol);

      expect(res.status).toBe(403);
      expect(cart.removeItem).not.toHaveBeenCalled();
    });
  });

  describe('DELETE /orders/cart', () => {
    it('responde 204 y vacía el carrito', async () => {
      cart.clear.mockResolvedValue(undefined);

      const res = await http().delete('/orders/cart');

      expect(res.status).toBe(204);
      expect(cart.clear).toHaveBeenCalledWith(USER_ID);
    });

    it.each(['PROVEEDOR', 'ADMIN'])('responde 403 a %s', async (rol) => {
      const res = await http().delete('/orders/cart').set('x-test-rol', rol);

      expect(res.status).toBe(403);
      expect(cart.clear).not.toHaveBeenCalled();
    });
  });
});

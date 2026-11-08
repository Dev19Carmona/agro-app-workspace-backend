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
import { ProviderOrdersController } from '../controllers/provider-orders.controller.js';
import { OrdersService } from '../services/orders.service.js';

const USER_ID = '6aee7a351616d80ba08c95aa';
const STORE_ID = 's1'.repeat(12);
const ID = 'a1'.repeat(12);

/** Sustituye a `JwtAuthGuard`: rol y tienda salen de cabeceras `x-test-*`. */
class FakeAuthGuard implements CanActivate {
  canActivate(context: ExecutionContext): boolean {
    const req = context.switchToHttp().getRequest();
    const storeId = req.headers['x-test-store'];
    req.user = {
      id: USER_ID,
      rol: req.headers['x-test-rol'] ?? 'PROVEEDOR',
      sessionId: 'fam-1',
      ...(storeId !== 'none' && { storeId: storeId ?? STORE_ID }),
    };
    return true;
  }
}

describe('ProviderOrdersController (HTTP con pipe y RolesGuard reales)', () => {
  const orders = {
    listProviderSubOrders: vi.fn(),
    getProviderSubOrder: vi.fn(),
  };
  let app: INestApplication;
  const http = () => request(app.getHttpServer());

  beforeEach(async () => {
    vi.resetAllMocks();
    const moduleRef = await Test.createTestingModule({
      controllers: [ProviderOrdersController],
      providers: [
        { provide: OrdersService, useValue: orders },
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

  describe('GET /orders/provider/sub-orders', () => {
    it('lista con la tienda del token y limit 20 por defecto', async () => {
      orders.listProviderSubOrders.mockResolvedValue({
        data: [],
        page: 1,
        limit: 20,
        total: 0,
      });

      const res = await http().get('/orders/provider/sub-orders');

      expect(res.status).toBe(200);
      expect(orders.listProviderSubOrders).toHaveBeenCalledWith(STORE_ID, {
        page: 1,
        limit: 20,
      });
    });

    it('sin storeId en el token pasa undefined (la lista sale vacía)', async () => {
      orders.listProviderSubOrders.mockResolvedValue({ data: [] });

      await http()
        .get('/orders/provider/sub-orders')
        .set('x-test-store', 'none');

      expect(orders.listProviderSubOrders).toHaveBeenCalledWith(
        undefined,
        expect.anything(),
      );
    });

    it.each(['limit=101', 'status=CONFIRMED', 'buyerId=' + 'a'.repeat(24)])(
      'rechaza ?%s con 400',
      async (qs) => {
        const res = await http().get(`/orders/provider/sub-orders?${qs}`);

        expect(res.status).toBe(400);
        expect(orders.listProviderSubOrders).not.toHaveBeenCalled();
      },
    );

    it.each(['PRODUCTOR', 'ADMIN'])('responde 403 a %s', async (rol) => {
      const res = await http()
        .get('/orders/provider/sub-orders')
        .set('x-test-rol', rol);

      expect(res.status).toBe(403);
      expect(orders.listProviderSubOrders).not.toHaveBeenCalled();
    });
  });

  describe('GET /orders/provider/sub-orders/:id', () => {
    it('devuelve el sub-pedido usando la tienda del token', async () => {
      orders.getProviderSubOrder.mockResolvedValue({ id: ID });

      const res = await http().get(`/orders/provider/sub-orders/${ID}`);

      expect(res.status).toBe(200);
      expect(orders.getProviderSubOrder).toHaveBeenCalledWith(STORE_ID, ID);
    });

    it('un sub-pedido ajeno o sin pagar da 404 (lo decide el servicio)', async () => {
      const { NotFoundException } = await import('@nestjs/common');
      orders.getProviderSubOrder.mockRejectedValue(new NotFoundException());

      const res = await http().get(`/orders/provider/sub-orders/${ID}`);

      expect(res.status).toBe(404);
    });

    it('rechaza un id que no es ObjectId con 400', async () => {
      const res = await http().get('/orders/provider/sub-orders/abc');

      expect(res.status).toBe(400);
      expect(orders.getProviderSubOrder).not.toHaveBeenCalled();
    });

    it.each(['PRODUCTOR', 'ADMIN'])('responde 403 a %s', async (rol) => {
      const res = await http()
        .get(`/orders/provider/sub-orders/${ID}`)
        .set('x-test-rol', rol);

      expect(res.status).toBe(403);
    });
  });
});

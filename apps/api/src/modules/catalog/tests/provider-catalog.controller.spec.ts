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
import { ProviderCatalogController } from '../controllers/provider-catalog.controller.js';
import { ProductsService } from '../services/products.service.js';
import { StockService } from '../services/stock.service.js';
import { StoresService } from '../services/stores.service.js';

const USER_ID = '6aee7a351616d80ba08c95aa';

/** Sustituye a `JwtAuthGuard`: el rol sale de la cabecera `x-test-rol`. */
class FakeAuthGuard implements CanActivate {
  canActivate(context: ExecutionContext): boolean {
    const req = context.switchToHttp().getRequest();
    req.user = {
      id: USER_ID,
      rol: req.headers['x-test-rol'] ?? 'PROVEEDOR',
      sessionId: 'fam-1',
    };
    return true;
  }
}

describe('ProviderCatalogController (HTTP con pipe y RolesGuard reales)', () => {
  const stores = { create: vi.fn(), getMine: vi.fn() };
  const products = {
    createProduct: vi.fn(),
    updateProduct: vi.fn(),
    createVariant: vi.fn(),
    updateVariant: vi.fn(),
    listMine: vi.fn(),
  };
  const stockService = { setStock: vi.fn() };
  const body = { nombre: 'Agro Sur', nit: '900123', municipio: 'Pasto' };
  let app: INestApplication;
  const http = () => request(app.getHttpServer());

  beforeEach(async () => {
    vi.resetAllMocks();
    const moduleRef = await Test.createTestingModule({
      controllers: [ProviderCatalogController],
      providers: [
        { provide: StoresService, useValue: stores },
        { provide: ProductsService, useValue: products },
        { provide: StockService, useValue: stockService },
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

  describe('POST /catalog/stores', () => {
    it('crea la tienda con el id del token y responde 201', async () => {
      stores.create.mockResolvedValue({ id: 's1', ownerId: USER_ID });

      const res = await http().post('/catalog/stores').send(body);

      expect(res.status).toBe(201);
      expect(res.body.ownerId).toBe(USER_ID);
      expect(stores.create).toHaveBeenCalledWith(USER_ID, body);
    });

    it('rechaza ownerId en el body con 400', async () => {
      const res = await http()
        .post('/catalog/stores')
        .send({ ...body, ownerId: USER_ID });

      expect(res.status).toBe(400);
      expect(stores.create).not.toHaveBeenCalled();
    });

    it('rechaza un operador {"$ne": null} con 400', async () => {
      const res = await http()
        .post('/catalog/stores')
        .send({ ...body, nombre: { $ne: null } });

      expect(res.status).toBe(400);
      expect(stores.create).not.toHaveBeenCalled();
    });

    it.each(['PRODUCTOR', 'ADMIN'])('responde 403 a %s', async (rol) => {
      const res = await http()
        .post('/catalog/stores')
        .set('x-test-rol', rol)
        .send(body);

      expect(res.status).toBe(403);
      expect(stores.create).not.toHaveBeenCalled();
    });
  });

  describe('GET /catalog/my-store', () => {
    it('devuelve la tienda del proveedor autenticado', async () => {
      stores.getMine.mockResolvedValue({ id: 's1', ownerId: USER_ID });

      const res = await http().get('/catalog/my-store');

      expect(res.status).toBe(200);
      expect(stores.getMine).toHaveBeenCalledWith(USER_ID);
    });

    it('responde 403 a un PRODUCTOR', async () => {
      const res = await http()
        .get('/catalog/my-store')
        .set('x-test-rol', 'PRODUCTOR');

      expect(res.status).toBe(403);
    });
  });

  describe('GET /catalog/my-store/products', () => {
    it('pasa user.id y la paginación por defecto al servicio', async () => {
      products.listMine.mockResolvedValue({ data: [], total: 0 });

      const res = await http().get('/catalog/my-store/products');

      expect(res.status).toBe(200);
      expect(products.listMine).toHaveBeenCalledWith(USER_ID, {
        page: 1,
        limit: 20,
      });
    });

    it('rechaza parámetros desconocidos con 400', async () => {
      const res = await http().get('/catalog/my-store/products?storeId=x');

      expect(res.status).toBe(400);
    });

    it('responde 403 a un PRODUCTOR', async () => {
      const res = await http()
        .get('/catalog/my-store/products')
        .set('x-test-rol', 'PRODUCTOR');

      expect(res.status).toBe(403);
    });
  });

  describe('productos y variantes', () => {
    const ID = '6aee7a351616d80ba08c95b4';
    const producto = {
      categoryId: ID,
      nombre: 'Herbicida',
      marca: 'Agro',
      fichaTecnica: { ingrediente: 'glifosato' },
    };
    const variante = {
      presentacion: '4 L',
      unidad: 'L',
      precio: 1000,
      stock: 5,
    };

    it('POST /catalog/products crea con el id del token y responde 201', async () => {
      products.createProduct.mockResolvedValue({ id: ID });

      const res = await http().post('/catalog/products').send(producto);

      expect(res.status).toBe(201);
      expect(products.createProduct).toHaveBeenCalledWith(USER_ID, producto);
    });

    it('POST /catalog/products rechaza storeId en el body con 400', async () => {
      const res = await http()
        .post('/catalog/products')
        .send({ ...producto, storeId: ID });

      expect(res.status).toBe(400);
      expect(products.createProduct).not.toHaveBeenCalled();
    });

    it('PATCH /catalog/products/:id edita y valida el id', async () => {
      products.updateProduct.mockResolvedValue({ id: ID });

      const ok = await http()
        .patch(`/catalog/products/${ID}`)
        .send({ activo: false });
      const mal = await http()
        .patch('/catalog/products/abc')
        .send({ activo: false });

      expect(ok.status).toBe(200);
      expect(products.updateProduct).toHaveBeenCalledWith(USER_ID, ID, {
        activo: false,
      });
      expect(mal.status).toBe(400);
    });

    it('POST /catalog/products/:id/variants crea y responde 201', async () => {
      products.createVariant.mockResolvedValue({ id: ID });

      const res = await http()
        .post(`/catalog/products/${ID}/variants`)
        .send(variante);

      expect(res.status).toBe(201);
      expect(products.createVariant).toHaveBeenCalledWith(
        USER_ID,
        ID,
        variante,
      );
    });

    it('POST variants rechaza precioOferta >= precio con 400', async () => {
      const res = await http()
        .post(`/catalog/products/${ID}/variants`)
        .send({ ...variante, precioOferta: 1000 });

      expect(res.status).toBe(400);
      expect(products.createVariant).not.toHaveBeenCalled();
    });

    it('PATCH /catalog/variants/:id admite precioOferta null y rechaza stock', async () => {
      products.updateVariant.mockResolvedValue({ id: ID });

      const ok = await http()
        .patch(`/catalog/variants/${ID}`)
        .send({ precioOferta: null });
      const stock = await http()
        .patch(`/catalog/variants/${ID}`)
        .send({ stock: 3 });

      expect(ok.status).toBe(200);
      expect(products.updateVariant).toHaveBeenCalledWith(USER_ID, ID, {
        precioOferta: null,
      });
      expect(stock.status).toBe(400);
    });

    it('PATCH /catalog/variants/:id/stock fija el stock con el id del token', async () => {
      stockService.setStock.mockResolvedValue({ id: ID, stock: 8 });

      const res = await http()
        .patch(`/catalog/variants/${ID}/stock`)
        .send({ stock: 8 });

      expect(res.status).toBe(200);
      expect(stockService.setStock).toHaveBeenCalledWith(USER_ID, ID, 8);
    });

    it('PATCH stock rechaza negativos, decimales, extras y operadores con 400', async () => {
      const cuerpos = [
        { stock: -1 },
        { stock: 1.5 },
        { stock: 1, stockReservado: 0 },
        { stock: { $ne: null } },
        {},
      ];
      for (const cuerpo of cuerpos) {
        const res = await http()
          .patch(`/catalog/variants/${ID}/stock`)
          .send(cuerpo);
        expect(res.status).toBe(400);
      }
      expect(stockService.setStock).not.toHaveBeenCalled();
    });

    it.each(['ADMIN', 'PRODUCTOR'])(
      'responde 403 a %s en PATCH stock',
      async (rol) => {
        const res = await http()
          .patch(`/catalog/variants/${ID}/stock`)
          .set('x-test-rol', rol)
          .send({ stock: 8 });

        expect(res.status).toBe(403);
        expect(stockService.setStock).not.toHaveBeenCalled();
      },
    );

    it.each(['ADMIN', 'PRODUCTOR'])(
      'responde 403 a %s en los endpoints de producto',
      async (rol) => {
        const rutas = [
          () => http().post('/catalog/products').send(producto),
          () => http().patch(`/catalog/products/${ID}`).send({ activo: true }),
          () => http().post(`/catalog/products/${ID}/variants`).send(variante),
          () => http().patch(`/catalog/variants/${ID}`).send({ activo: true }),
        ];
        for (const crear of rutas) {
          const res = await crear().set('x-test-rol', rol);
          expect(res.status).toBe(403);
        }
        expect(products.createProduct).not.toHaveBeenCalled();
      },
    );
  });
});

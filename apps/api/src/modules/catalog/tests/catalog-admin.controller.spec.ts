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
import { CatalogAdminController } from '../controllers/catalog-admin.controller.js';
import { CategoriesService } from '../services/categories.service.js';
import { StoresService } from '../services/stores.service.js';

const ID = '6aee7a351616d80ba08c95b4';
const ADMIN_ID = '6aee7a351616d80ba08c95aa';

/** Sustituye a `JwtAuthGuard`: el rol sale de la cabecera `x-test-rol`. */
class FakeAuthGuard implements CanActivate {
  canActivate(context: ExecutionContext): boolean {
    const req = context.switchToHttp().getRequest();
    req.user = {
      id: ADMIN_ID,
      rol: req.headers['x-test-rol'] ?? 'ADMIN',
      sessionId: 'fam-1',
    };
    return true;
  }
}

describe('CatalogAdminController (HTTP con pipe y RolesGuard reales)', () => {
  const categories = { create: vi.fn(), update: vi.fn() };
  const stores = {
    listAdmin: vi.fn(),
    findOneAdmin: vi.fn(),
    updateAdmin: vi.fn(),
    deactivate: vi.fn(),
  };
  let app: INestApplication;
  const http = () => request(app.getHttpServer());

  beforeEach(async () => {
    vi.resetAllMocks();
    const moduleRef = await Test.createTestingModule({
      controllers: [CatalogAdminController],
      providers: [
        { provide: CategoriesService, useValue: categories },
        { provide: StoresService, useValue: stores },
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

  describe('POST /catalog/categories', () => {
    it('crea la categoría y responde 201', async () => {
      categories.create.mockResolvedValue({ id: ID, nombre: 'Semillas' });

      const res = await http()
        .post('/catalog/categories')
        .send({ nombre: 'Semillas' });

      expect(res.status).toBe(201);
      expect(categories.create).toHaveBeenCalledWith({ nombre: 'Semillas' });
    });

    it.each(['PROVEEDOR', 'PRODUCTOR'])('responde 403 a %s', async (rol) => {
      const res = await http()
        .post('/catalog/categories')
        .set('x-test-rol', rol)
        .send({ nombre: 'Semillas' });

      expect(res.status).toBe(403);
      expect(categories.create).not.toHaveBeenCalled();
    });

    it('rechaza propiedades extra y operadores con 400', async () => {
      const extra = await http()
        .post('/catalog/categories')
        .send({ nombre: 'S', activa: false });
      const operador = await http()
        .post('/catalog/categories')
        .send({ nombre: { $ne: null } });

      expect(extra.status).toBe(400);
      expect(operador.status).toBe(400);
      expect(categories.create).not.toHaveBeenCalled();
    });
  });

  describe('PATCH /catalog/categories/:id', () => {
    it('actualiza y responde 200', async () => {
      categories.update.mockResolvedValue({ id: ID, activa: false });

      const res = await http()
        .patch(`/catalog/categories/${ID}`)
        .send({ activa: false });

      expect(res.status).toBe(200);
      expect(categories.update).toHaveBeenCalledWith(ID, { activa: false });
    });

    it('responde 403 a PROVEEDOR', async () => {
      const res = await http()
        .patch(`/catalog/categories/${ID}`)
        .set('x-test-rol', 'PROVEEDOR')
        .send({ activa: false });

      expect(res.status).toBe(403);
    });

    it('rechaza un id que no es ObjectId y un body vacío con 400', async () => {
      const id = await http()
        .patch('/catalog/categories/abc')
        .send({ activa: true });
      const vacio = await http().patch(`/catalog/categories/${ID}`).send({});

      expect(id.status).toBe(400);
      expect(vacio.status).toBe(400);
      expect(categories.update).not.toHaveBeenCalled();
    });
  });

  describe('tiendas del ADMIN', () => {
    it('GET /catalog/admin/stores lista con paginación por defecto', async () => {
      stores.listAdmin.mockResolvedValue({ data: [], total: 0 });

      const res = await http().get('/catalog/admin/stores');

      expect(res.status).toBe(200);
      expect(stores.listAdmin).toHaveBeenCalledWith({ page: 1, limit: 20 });
    });

    it('GET /catalog/admin/stores rechaza limit 101 con 400', async () => {
      const res = await http().get('/catalog/admin/stores?limit=101');

      expect(res.status).toBe(400);
      expect(stores.listAdmin).not.toHaveBeenCalled();
    });

    it('GET /catalog/admin/stores/:id devuelve el detalle', async () => {
      stores.findOneAdmin.mockResolvedValue({ id: ID });

      const res = await http().get(`/catalog/admin/stores/${ID}`);

      expect(res.status).toBe(200);
      expect(stores.findOneAdmin).toHaveBeenCalledWith(ID);
    });

    it('PATCH /catalog/admin/stores/:id acepta nombre, nit y municipio', async () => {
      stores.updateAdmin.mockResolvedValue({ id: ID });

      const res = await http()
        .patch(`/catalog/admin/stores/${ID}`)
        .send({ nit: '123' });

      expect(res.status).toBe(200);
      expect(stores.updateAdmin).toHaveBeenCalledWith(ID, { nit: '123' });
    });

    it('PATCH /catalog/admin/stores/:id rechaza activa y ownerId con 400', async () => {
      const activa = await http()
        .patch(`/catalog/admin/stores/${ID}`)
        .send({ activa: true });
      const owner = await http()
        .patch(`/catalog/admin/stores/${ID}`)
        .send({ ownerId: ID });

      expect(activa.status).toBe(400);
      expect(owner.status).toBe(400);
      expect(stores.updateAdmin).not.toHaveBeenCalled();
    });

    it('POST /catalog/admin/stores/:id/deactivate responde 200', async () => {
      stores.deactivate.mockResolvedValue({ id: ID, activa: false });

      const res = await http().post(`/catalog/admin/stores/${ID}/deactivate`);

      expect(res.status).toBe(200);
      expect(stores.deactivate).toHaveBeenCalledWith(ID);
    });

    it.each([
      ['get', '/catalog/admin/stores'],
      ['get', `/catalog/admin/stores/${ID}`],
      ['patch', `/catalog/admin/stores/${ID}`],
      ['post', `/catalog/admin/stores/${ID}/deactivate`],
    ] as const)('%s %s responde 403 a PROVEEDOR', async (metodo, ruta) => {
      const res = await http()
        [metodo](ruta)
        .set('x-test-rol', 'PROVEEDOR')
        .send({ nit: '1' });

      expect(res.status).toBe(403);
    });
  });
});

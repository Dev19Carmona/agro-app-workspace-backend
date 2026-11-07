import {
  type CanActivate,
  type ExecutionContext,
  type INestApplication,
  StandardSchemaValidationPipe,
} from '@nestjs/common';
import { APP_GUARD, APP_PIPE } from '@nestjs/core';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { RolesGuard } from '../../../../../libs/common/src/security/roles.guard.js';
import { UsersAdminController } from './users-admin.controller.js';
import { UsersService } from './users.service.js';

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

describe('UsersAdminController (HTTP con pipe y RolesGuard reales)', () => {
  const service = {
    list: vi.fn(),
    findOne: vi.fn(),
    approve: vi.fn(),
    reject: vi.fn(),
    disable: vi.fn(),
    enable: vi.fn(),
    changeRole: vi.fn(),
  };
  let app: INestApplication;
  const http = () => request(app.getHttpServer());

  beforeEach(async () => {
    vi.resetAllMocks();
    const moduleRef = await Test.createTestingModule({
      controllers: [UsersAdminController],
      providers: [
        { provide: UsersService, useValue: service },
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

  describe('solo ADMIN', () => {
    const rutas: [string, string][] = [
      ['get', '/auth/users'],
      ['get', `/auth/users/${ID}`],
      ['post', `/auth/users/${ID}/approve`],
      ['post', `/auth/users/${ID}/reject`],
      ['post', `/auth/users/${ID}/disable`],
      ['post', `/auth/users/${ID}/enable`],
      ['patch', `/auth/users/${ID}/role`],
    ];

    it.each(['PRODUCTOR', 'PROVEEDOR'])(
      '%s recibe 403 en todas las rutas y no llega al servicio',
      async (rol) => {
        for (const [metodo, ruta] of rutas) {
          const res = await (http() as never as Record<string, Function>)
            [metodo](ruta)
            .set('x-test-rol', rol)
            .send({ rol: 'ADMIN' });
          expect(res.status, `${metodo} ${ruta}`).toBe(403);
        }
        for (const fn of Object.values(service)) {
          expect(fn).not.toHaveBeenCalled();
        }
      },
    );

    it('ADMIN recibe 200 en el listado', async () => {
      service.list.mockResolvedValue({ data: [], total: 0 });
      const res = await http().get('/auth/users');
      expect(res.status).toBe(200);
    });
  });

  describe('GET /auth/users', () => {
    it('aplica valores por defecto y convierte los números', async () => {
      service.list.mockResolvedValue({ data: [] });

      await http().get('/auth/users');
      expect(service.list).toHaveBeenLastCalledWith({ page: 1, limit: 20 });

      await http().get(
        '/auth/users?rol=PROVEEDOR&status=PENDING_APPROVAL&page=2&limit=50',
      );
      expect(service.list).toHaveBeenLastCalledWith({
        rol: 'PROVEEDOR',
        status: 'PENDING_APPROVAL',
        page: 2,
        limit: 50,
      });
    });

    it.each([
      ['limit sobre el máximo (101)', 'limit=101'],
      ['limit 0', 'limit=0'],
      ['page 0', 'page=0'],
      ['page no numérica', 'page=abc'],
      ['rol desconocido', 'rol=SUPERUSUARIO'],
      ['status desconocido', 'status=OTRO'],
      ['parámetro desconocido', 'passwordHash=x'],
      ['operador de Mongo', 'rol[$ne]=ADMIN'],
    ])('400 con %s', async (_caso, query) => {
      const res = await http().get(`/auth/users?${query}`);
      expect(res.status).toBe(400);
      expect(service.list).not.toHaveBeenCalled();
    });
  });

  describe('ids de la ruta', () => {
    it('400 con un id que no es ObjectId', async () => {
      const res = await http().get('/auth/users/no-es-un-id');
      expect(res.status).toBe(400);
      expect(service.findOne).not.toHaveBeenCalled();
    });

    it('200 con un ObjectId válido', async () => {
      service.findOne.mockResolvedValue({ id: ID });
      const res = await http().get(`/auth/users/${ID}`);
      expect(res.status).toBe(200);
      expect(service.findOne).toHaveBeenCalledWith(ID);
    });
  });

  describe('acciones', () => {
    it('approve delega con el id y el ADMIN autenticado', async () => {
      service.approve.mockResolvedValue({ id: ID });
      const res = await http().post(`/auth/users/${ID}/approve`);
      expect(res.status).toBe(200);
      expect(service.approve).toHaveBeenCalledWith(ID, ADMIN_ID);
    });

    it('reject sin body funciona (motivo opcional)', async () => {
      service.reject.mockResolvedValue({ id: ID });
      const res = await http().post(`/auth/users/${ID}/reject`);
      expect(res.status).toBe(200);
      expect(service.reject).toHaveBeenCalledWith(ID, ADMIN_ID, undefined);
    });

    it('reject con motivo lo pasa al servicio', async () => {
      service.reject.mockResolvedValue({ id: ID });
      await http()
        .post(`/auth/users/${ID}/reject`)
        .send({ reason: 'Documento ilegible' });
      expect(service.reject).toHaveBeenCalledWith(
        ID,
        ADMIN_ID,
        'Documento ilegible',
      );
    });

    it('reject rechaza propiedades desconocidas (400)', async () => {
      const res = await http()
        .post(`/auth/users/${ID}/reject`)
        .send({ reason: 'x', status: 'ACTIVE' });
      expect(res.status).toBe(400);
      expect(service.reject).not.toHaveBeenCalled();
    });

    it('disable y enable delegan con los ids correctos', async () => {
      service.disable.mockResolvedValue({ id: ID });
      service.enable.mockResolvedValue({ id: ID });

      expect((await http().post(`/auth/users/${ID}/disable`)).status).toBe(200);
      expect(service.disable).toHaveBeenCalledWith(ID, ADMIN_ID);
      expect((await http().post(`/auth/users/${ID}/enable`)).status).toBe(200);
      expect(service.enable).toHaveBeenCalledWith(ID);
    });

    it('PATCH role delega con el rol del body', async () => {
      service.changeRole.mockResolvedValue({ id: ID });
      const res = await http()
        .patch(`/auth/users/${ID}/role`)
        .send({ rol: 'ADMIN' });
      expect(res.status).toBe(200);
      expect(service.changeRole).toHaveBeenCalledWith(ID, ADMIN_ID, 'ADMIN');
    });

    it.each([
      ['rol desconocido', { rol: 'SUPERUSUARIO' }],
      ['sin rol', {}],
      ['propiedad extra', { rol: 'ADMIN', status: 'ACTIVE' }],
      ['rol como objeto', { rol: { $ne: null } }],
    ])('PATCH role responde 400 con %s', async (_caso, body) => {
      const res = await http().patch(`/auth/users/${ID}/role`).send(body);
      expect(res.status).toBe(400);
      expect(service.changeRole).not.toHaveBeenCalled();
    });
  });
});

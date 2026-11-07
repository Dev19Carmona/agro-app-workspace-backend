import {
  type CanActivate,
  type ExecutionContext,
  type INestApplication,
  StandardSchemaValidationPipe,
} from '@nestjs/common';
import { APP_GUARD, APP_PIPE } from '@nestjs/core';
import { Test } from '@nestjs/testing';
import { ThrottlerGuard, ThrottlerModule } from '@nestjs/throttler';
import request from 'supertest';
import { AuthController } from './auth.controller.js';
import { AuthService } from './auth.service.js';

const USUARIO = { id: 'u1', rol: 'PRODUCTOR', sessionId: 'fam-1' };

const registro = {
  email: 'ana@correo.com',
  password: 'Segura12345',
  nombre: 'Ana',
  documento: '1020304050',
  rol: 'PRODUCTOR',
  aceptaTratamientoDatos: true,
};

/** Sustituye a `JwtAuthGuard`: deja un usuario autenticado fijo en la petición. */
class FakeAuthGuard implements CanActivate {
  canActivate(context: ExecutionContext): boolean {
    context.switchToHttp().getRequest().user = USUARIO;
    return true;
  }
}

describe('AuthController (HTTP con pipe y throttler reales)', () => {
  const register = vi.fn();
  const login = vi.fn();
  const refresh = vi.fn();
  const logout = vi.fn();
  const getProfile = vi.fn();
  const changePassword = vi.fn();
  let app: INestApplication;

  beforeEach(async () => {
    vi.resetAllMocks();
    const moduleRef = await Test.createTestingModule({
      imports: [ThrottlerModule.forRoot([{ ttl: 60_000, limit: 100 }])],
      controllers: [AuthController],
      providers: [
        {
          provide: AuthService,
          useValue: {
            register,
            login,
            refresh,
            logout,
            getProfile,
            changePassword,
          },
        },
        { provide: APP_PIPE, useClass: StandardSchemaValidationPipe },
        { provide: APP_GUARD, useClass: ThrottlerGuard },
        { provide: APP_GUARD, useClass: FakeAuthGuard },
      ],
    }).compile();
    app = moduleRef.createNestApplication();
    await app.init();
  });

  afterEach(async () => {
    await app.close();
  });

  describe('POST /auth/register', () => {
    it('201 con un registro válido y delega en el servicio', async () => {
      register.mockResolvedValue({ id: '1', email: registro.email });

      const res = await request(app.getHttpServer())
        .post('/auth/register')
        .send(registro);

      expect(res.status).toBe(201);
      expect(res.body).toEqual({ id: '1', email: registro.email });
      expect(register).toHaveBeenCalledWith(registro);
    });

    it.each([
      ['rol ADMIN', { ...registro, rol: 'ADMIN' }],
      ['propiedad desconocida status', { ...registro, status: 'ACTIVE' }],
      [
        'sin aceptaTratamientoDatos',
        { ...registro, aceptaTratamientoDatos: undefined },
      ],
    ])('400 con %s y no llega al servicio', async (_caso, body) => {
      const res = await request(app.getHttpServer())
        .post('/auth/register')
        .send(body);

      expect(res.status).toBe(400);
      expect(register).not.toHaveBeenCalled();
    });

    it('limita a 5/min por IP: la sexta devuelve 429', async () => {
      register.mockResolvedValue({});
      const estados: number[] = [];
      for (let i = 0; i < 6; i++) {
        const res = await request(app.getHttpServer())
          .post('/auth/register')
          .send(registro);
        estados.push(res.status);
      }
      expect(estados).toEqual([201, 201, 201, 201, 201, 429]);
    });
  });

  describe('POST /auth/login', () => {
    const credenciales = { email: 'ana@correo.com', password: 'Segura12345' };

    it('200 con credenciales bien formadas', async () => {
      login.mockResolvedValue({ accessToken: 'jwt' });

      const res = await request(app.getHttpServer())
        .post('/auth/login')
        .send(credenciales);

      expect(res.status).toBe(200);
      expect(res.body).toEqual({ accessToken: 'jwt' });
      expect(login).toHaveBeenCalledWith(credenciales);
    });

    it('400 con email como objeto {"$ne": null} y no llega al servicio (ni a Mongo)', async () => {
      const res = await request(app.getHttpServer())
        .post('/auth/login')
        .send({ email: { $ne: null }, password: 'x' });

      expect(res.status).toBe(400);
      expect(login).not.toHaveBeenCalled();
    });

    it('limita a 5/min por IP: la sexta devuelve 429', async () => {
      login.mockResolvedValue({});
      const estados: number[] = [];
      for (let i = 0; i < 6; i++) {
        const res = await request(app.getHttpServer())
          .post('/auth/login')
          .send(credenciales);
        estados.push(res.status);
      }
      expect(estados).toEqual([200, 200, 200, 200, 200, 429]);
    });
  });

  describe('POST /auth/refresh', () => {
    it('200 y delega en el servicio con el refresh token', async () => {
      refresh.mockResolvedValue({ accessToken: 'jwt2' });

      const res = await request(app.getHttpServer())
        .post('/auth/refresh')
        .send({ refreshToken: 'abc' });

      expect(res.status).toBe(200);
      expect(refresh).toHaveBeenCalledWith({ refreshToken: 'abc' });
    });

    it.each([
      ['sin refreshToken', {}],
      ['refreshToken como objeto', { refreshToken: { $ne: null } }],
      ['propiedad desconocida', { refreshToken: 'abc', rol: 'ADMIN' }],
    ])('400 %s', async (_caso, body) => {
      const res = await request(app.getHttpServer())
        .post('/auth/refresh')
        .send(body);

      expect(res.status).toBe(400);
      expect(refresh).not.toHaveBeenCalled();
    });

    it('limita a 10/min por IP: la 11.ª devuelve 429', async () => {
      refresh.mockResolvedValue({});
      let ultimo = 0;
      for (let i = 0; i < 11; i++) {
        ultimo = (
          await request(app.getHttpServer())
            .post('/auth/refresh')
            .send({ refreshToken: 'abc' })
        ).status;
      }
      expect(ultimo).toBe(429);
      expect(refresh).toHaveBeenCalledTimes(10);
    });
  });

  describe('POST /auth/logout', () => {
    it('204 y cierra la sesión del token actual', async () => {
      const res = await request(app.getHttpServer()).post('/auth/logout');

      expect(res.status).toBe(204);
      expect(logout).toHaveBeenCalledWith('fam-1');
    });
  });

  describe('GET /auth/me', () => {
    it('200 con el perfil del usuario autenticado', async () => {
      getProfile.mockResolvedValue({ id: 'u1', email: 'ana@correo.com' });

      const res = await request(app.getHttpServer()).get('/auth/me');

      expect(res.status).toBe(200);
      expect(res.body).toEqual({ id: 'u1', email: 'ana@correo.com' });
      expect(getProfile).toHaveBeenCalledWith('u1');
    });
  });

  describe('POST /auth/change-password', () => {
    const cuerpo = {
      currentPassword: 'Actual12345',
      newPassword: 'Nueva123456',
    };

    it('204 y delega con el id del usuario autenticado', async () => {
      const res = await request(app.getHttpServer())
        .post('/auth/change-password')
        .send(cuerpo);

      expect(res.status).toBe(204);
      expect(changePassword).toHaveBeenCalledWith('u1', cuerpo);
    });

    it.each([
      ['sin newPassword', { currentPassword: 'x' }],
      ['propiedad desconocida', { ...cuerpo, userId: 'otro' }],
      ['tipos no esperados', { currentPassword: { $ne: 1 }, newPassword: 'x' }],
    ])('400 %s', async (_caso, body) => {
      const res = await request(app.getHttpServer())
        .post('/auth/change-password')
        .send(body);

      expect(res.status).toBe(400);
      expect(changePassword).not.toHaveBeenCalled();
    });

    it('limita a 5/min por IP: la sexta devuelve 429', async () => {
      const estados: number[] = [];
      for (let i = 0; i < 6; i++) {
        estados.push(
          (
            await request(app.getHttpServer())
              .post('/auth/change-password')
              .send(cuerpo)
          ).status,
        );
      }
      expect(estados).toEqual([204, 204, 204, 204, 204, 429]);
    });
  });
});

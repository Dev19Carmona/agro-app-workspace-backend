// E2E del módulo auth y la seguridad transversal, contra MongoDB real.
//
// - Necesita MONGODB_URI (entorno o `.env`) y un MongoDB en replica set
//   (`docker compose up -d --wait`).
// - Las claves JWT las genera la propia suite: no usa las de tu `.env`.
// - `api` usa la base fija `mini-croper`: la suite solo crea usuarios con email
//   `e2e-*-<id de ejecución>@test.co` y los borra al terminar.
// - El throttler cuenta por IP. Con `trust proxy` activado solo en la suite,
//   cada petición usa su propia IP vía `X-Forwarded-For`, salvo en las pruebas
//   de límites, que fijan una.
import { createHash, generateKeyPairSync, randomUUID } from 'node:crypto';
import { ConsoleLogger, type INestApplication } from '@nestjs/common';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { JwtService } from '@nestjs/jwt';
import { getConnectionToken, getModelToken } from '@nestjs/mongoose';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { Test } from '@nestjs/testing';
import type { Connection } from 'mongoose';
import request from 'supertest';
import { buildAdminDocument } from '../../../scripts/seed-admin.ts';
import { setupSwagger } from '../../../libs/common/src/swagger/setup-swagger.js';

const PASSWORD = 'Segura12345';
const DOCUMENTO = '1020304050';
const ALLOWED_ORIGIN = 'http://app.com';
const RUN = randomUUID().slice(0, 8);
const email = (name: string) => `e2e-${name}-${RUN}@test.co`;

// Claves propias de la suite; deben fijarse antes de importar `ApiModule`,
// porque `ConfigModule.forRoot` valida el entorno al evaluarse el módulo.
const keys = generateKeyPairSync('rsa', {
  modulusLength: 2048,
  privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
  publicKeyEncoding: { type: 'spki', format: 'pem' },
});
process.env.JWT_PRIVATE_KEY = keys.privateKey;
process.env.JWT_PUBLIC_KEY = keys.publicKey;
process.env.CORS_ORIGINS = ALLOWED_ORIGIN;

const signer = new JwtService({ privateKey: keys.privateKey });
const claims = { sub: '6aee7a351616d80ba08c95b4', rol: 'ADMIN', sid: 'x' };
const jwtOptions = {
  algorithm: 'RS256',
  issuer: 'mini-croper',
  audience: 'mini-croper-api',
} as const;
const b64 = (o: object) => Buffer.from(JSON.stringify(o)).toString('base64url');
const sha256 = (v: string) => createHash('sha256').update(v).digest('hex');

type Method = 'get' | 'post' | 'patch';
type Opts = { body?: object; token?: string; ip?: string; headers?: object };
type Json = Record<string, any>;

describe('auth y seguridad transversal (e2e)', () => {
  let app: NestExpressApplication;
  let conn: Connection;
  let events: EventEmitter2;
  let adminToken: string;
  let adminId: string;

  /** Todo lo que salga por stdout/stderr, para comprobar que no filtra secretos. */
  const logs: string[] = [];
  /** Tokens emitidos durante la suite: no deben aparecer en los logs. */
  const issuedTokens = new Set<string>();

  let ipCounter = 0;
  const nextIp = () =>
    `10.20.${Math.floor(++ipCounter / 250)}.${(ipCounter % 250) + 1}`;

  const call = (method: Method, path: string, opts: Opts = {}) => {
    let req = request(app.getHttpServer())
      [method](path)
      .set('X-Forwarded-For', opts.ip ?? nextIp());
    if (opts.token) req = req.set('Authorization', `Bearer ${opts.token}`);
    for (const [k, v] of Object.entries(opts.headers ?? {})) {
      req = req.set(k, String(v));
    }
    return opts.body === undefined ? req : req.send(opts.body);
  };

  const registerBody = (name: string, rol = 'PRODUCTOR', extra: Json = {}) => ({
    email: email(name),
    password: PASSWORD,
    nombre: `Usuario ${name}`,
    documento: DOCUMENTO,
    rol,
    aceptaTratamientoDatos: true,
    ...extra,
  });
  const register = (name: string, rol = 'PRODUCTOR', extra: Json = {}) =>
    call('post', '/auth/register', { body: registerBody(name, rol, extra) });

  const login = async (name: string, password = PASSWORD, ip?: string) => {
    const res = await call('post', '/auth/login', {
      body: { email: email(name), password },
      ip,
    });
    for (const t of [res.body.accessToken, res.body.refreshToken]) {
      if (t) issuedTokens.add(t);
    }
    return res;
  };

  const refresh = (refreshToken: string) =>
    call('post', '/auth/refresh', { body: { refreshToken } });

  /** Registra y abre sesión; devuelve id y tokens. */
  async function registerAndLogin(name: string, rol = 'PRODUCTOR') {
    const reg = await register(name, rol);
    expect(reg.status).toBe(201);
    const res = await login(name);
    expect(res.status).toBe(200);
    return {
      id: reg.body.id as string,
      accessToken: res.body.accessToken as string,
      refreshToken: res.body.refreshToken as string,
    };
  }

  const userDoc = (name: string) =>
    conn.collection('users').findOne({ email: email(name) });

  beforeAll(async () => {
    vi.spyOn(process.stdout, 'write').mockImplementation(((chunk: unknown) => {
      logs.push(String(chunk));
      return true;
    }) as never);
    vi.spyOn(process.stderr, 'write').mockImplementation(((chunk: unknown) => {
      logs.push(String(chunk));
      return true;
    }) as never);

    const { ApiModule } = await import('../src/api.module.js');
    const { applySecurity } =
      await import('../../../libs/common/src/security/apply-security.js');
    const { PasswordService } =
      await import('../src/modules/auth/services/password.service.js');

    // El módulo de pruebas no registra nada por defecto: con un logger real se
    // capturan también los logs de arranque.
    const moduleRef = await Test.createTestingModule({ imports: [ApiModule] })
      .setLogger(new ConsoleLogger({ logLevels: ['log', 'warn', 'error'] }))
      .compile();
    app = moduleRef.createNestApplication<NestExpressApplication>();
    app.set('trust proxy', true);
    applySecurity(app, { corsOrigins: [ALLOWED_ORIGIN] });
    setupSwagger(app, { title: 'e2e', description: 'e2e' });
    await app.init();

    conn = app.get<Connection>(getConnectionToken());
    events = app.get(EventEmitter2);

    // El primer ADMIN sale del seed; aquí se inserta con el mismo documento.
    const hash = await app
      .get(PasswordService, { strict: false })
      .hash(PASSWORD);
    const inserted = await conn
      .collection('users')
      .insertOne(buildAdminDocument(email('admin'), hash));
    adminId = inserted.insertedId.toString();
    const res = await login('admin');
    expect(res.status).toBe(200);
    adminToken = res.body.accessToken;
  });

  afterAll(async () => {
    vi.restoreAllMocks();
    const users = await conn
      .collection('users')
      .find({ email: new RegExp(`^e2e-.*-${RUN}@test\\.co$`) })
      .toArray();
    const ids = users.map((u) => u._id);
    await conn
      .collection('refresh_tokens')
      .deleteMany({ userId: { $in: ids } });
    await conn.collection('users').deleteMany({ _id: { $in: ids } });
    await app.close();
  });

  describe('rutas protegidas y públicas', () => {
    const protegidas = [
      '/catalog',
      '/orders',
      '/payments',
      '/auth/me',
      '/auth/users',
    ];

    it.each(protegidas)('GET %s sin token responde 401', async (ruta) => {
      expect((await call('get', ruta)).status).toBe(401);
    });

    it.each([
      ['malformado', 'esto.no.es-un-jwt'],
      [
        'firmado con otra clave',
        () =>
          new JwtService({
            privateKey: generateKeyPairSync('rsa', {
              modulusLength: 2048,
              privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
              publicKeyEncoding: { type: 'spki', format: 'pem' },
            }).privateKey,
          }).sign(claims, { ...jwtOptions, expiresIn: 900 }),
      ],
      [
        'expirado',
        () => signer.sign(claims, { ...jwtOptions, expiresIn: -10 }),
      ],
      [
        'HS256 con la clave pública como secreto',
        () =>
          new JwtService({ secret: keys.publicKey }).sign(claims, {
            algorithm: 'HS256',
            issuer: jwtOptions.issuer,
            audience: jwtOptions.audience,
            expiresIn: 900,
          }),
      ],
      [
        'alg: none',
        () =>
          `${b64({ alg: 'none', typ: 'JWT' })}.${b64({
            ...claims,
            iss: jwtOptions.issuer,
            aud: jwtOptions.audience,
            exp: Math.floor(Date.now() / 1000) + 900,
          })}.`,
      ],
    ] as [string, string | (() => string)][])(
      'token %s responde 401',
      async (_caso, token) => {
        const valor = typeof token === 'function' ? token() : token;
        for (const ruta of ['/catalog', '/auth/users']) {
          expect((await call('get', ruta, { token: valor })).status).toBe(401);
        }
      },
    );

    it('un token válido pasa el guard', async () => {
      expect(
        (await call('get', '/catalog', { token: adminToken })).status,
      ).toBe(200);
    });

    it('GET /health y los endpoints públicos responden sin token', async () => {
      expect((await call('get', '/health')).status).toBe(200);
      expect((await call('post', '/auth/register', { body: {} })).status).toBe(
        400,
      ); // llega al pipe, no se corta en el guard
      expect((await call('post', '/auth/login', { body: {} })).status).toBe(
        400,
      );
      expect((await call('post', '/auth/refresh', { body: {} })).status).toBe(
        400,
      );
    });
  });

  describe('registro', () => {
    it('PRODUCTOR: 201, ACTIVE, sin passwordHash en el cuerpo y con consentimiento', async () => {
      const res = await register('productor1');

      expect(res.status).toBe(201);
      expect(res.body).toMatchObject({ rol: 'PRODUCTOR', status: 'ACTIVE' });
      expect(JSON.stringify(res.body)).not.toMatch(/passwordHash|hash/i);
      const doc = await userDoc('productor1');
      expect(doc?.status).toBe('ACTIVE');
      expect(doc?.passwordHash).toMatch(/^\$2[aby]\$12\$/);
      expect(doc?.consent.acceptedAt).toBeInstanceOf(Date);
      expect(doc?.consent.version).toBe('1');
    });

    it('emite user.registered', async () => {
      const escucha = vi.fn();
      events.once('user.registered', escucha);

      const res = await register('evento1');

      expect(escucha).toHaveBeenCalledWith({
        userId: res.body.id,
        email: email('evento1'),
        rol: 'PRODUCTOR',
        status: 'ACTIVE',
      });
    });

    it('rol ADMIN responde 400 y no crea el usuario', async () => {
      expect((await register('intruso', 'ADMIN')).status).toBe(400);
      expect(await userDoc('intruso')).toBeNull();
    });

    it('una propiedad desconocida (status) responde 400', async () => {
      const res = await register('masivo', 'PRODUCTOR', { status: 'ACTIVE' });
      expect(res.status).toBe(400);
      expect(await userDoc('masivo')).toBeNull();
    });

    it('sin aceptaTratamientoDatos: true responde 400', async () => {
      for (const extra of [
        { aceptaTratamientoDatos: false },
        { aceptaTratamientoDatos: undefined },
      ]) {
        expect((await register('sinhabeas', 'PRODUCTOR', extra)).status).toBe(
          400,
        );
      }
    });

    it('un email repetido responde 409', async () => {
      expect((await register('duplicado')).status).toBe(201);
      expect((await register('duplicado')).status).toBe(409);
    });

    it('dos registros simultáneos del mismo email: uno 201 y otro 409, nunca 500', async () => {
      const [a, b] = await Promise.all([
        register('carrera'),
        register('carrera'),
      ]);
      expect([a.status, b.status].sort((x, y) => x - y)).toEqual([201, 409]);
    });

    it.each([
      ['9 caracteres', () => 'Abcdefg12'],
      ['más de 72 bytes', () => 'Aa1' + 'x'.repeat(80)],
      ['sin mayúscula', () => 'segura12345'],
      ['sin número', () => 'SeguraSegura'],
      ['que contiene el email', () => `Aa1-${email('politica')}`],
    ])('contraseña %s responde 400', async (_caso, password) => {
      const res = await register('politica', 'PRODUCTOR', {
        password: password(),
      });
      expect(res.status).toBe(400);
      expect(await userDoc('politica')).toBeNull();
    });
  });

  describe('login', () => {
    it('un email como objeto {"$ne": null} responde 400 y no consulta Mongo', async () => {
      const userModel = app.get(getModelToken('User'));
      const findOne = vi.spyOn(userModel, 'findOne');

      const res = await call('post', '/auth/login', {
        body: { email: { $ne: null }, password: PASSWORD },
      });

      expect(res.status).toBe(400);
      expect(findOne).not.toHaveBeenCalled();
      findOne.mockRestore();
    });

    it('email inexistente y contraseña incorrecta responden exactamente igual (401)', async () => {
      await register('mismo');
      const inexistente = await call('post', '/auth/login', {
        body: { email: email('nadie'), password: PASSWORD },
      });
      const incorrecta = await login('mismo', 'Incorrecta123');

      expect(inexistente.status).toBe(401);
      expect(incorrecta.status).toBe(401);
      expect(incorrecta.body).toEqual(inexistente.body);
    });

    it('el access token es RS256, dura 900 s y no trae email ni documento', async () => {
      await register('claims');
      const res = await login('claims');
      const token = res.body.accessToken as string;

      const { header, payload } = signer.decode(token, { complete: true });
      expect(header.alg).toBe('RS256');
      expect(payload.exp - payload.iat).toBe(900);
      expect(payload).toMatchObject({ rol: 'PRODUCTOR' });
      expect(JSON.stringify(payload)).not.toContain(email('claims'));
      expect(JSON.stringify(payload)).not.toContain(DOCUMENTO);
      expect(Object.keys(payload).sort((x, y) => x.localeCompare(y))).toEqual(
        ['aud', 'exp', 'iat', 'iss', 'rol', 'sid', 'sub'].sort((x, y) =>
          x.localeCompare(y),
        ),
      );
    });

    it('5 fallos bloquean 15 min: el sexto con la contraseña correcta da 401', async () => {
      await register('bloqueo');
      for (let i = 0; i < 5; i++) {
        expect((await login('bloqueo', 'Incorrecta123')).status).toBe(401);
      }

      const bloqueado = await login('bloqueo');
      expect(bloqueado.status).toBe(401);
      expect(bloqueado.body.accessToken).toBeUndefined();
      const doc = await userDoc('bloqueo');
      expect(doc?.failedLoginAttempts).toBe(5);
      const restante = doc!.lockedUntil.getTime() - Date.now();
      expect(restante).toBeGreaterThan(14 * 60_000);
      expect(restante).toBeLessThanOrEqual(15 * 60_000);

      // Pasado el tiempo de bloqueo el login funciona y el contador vuelve a 0.
      await conn
        .collection('users')
        .updateOne(
          { email: email('bloqueo') },
          { $set: { lockedUntil: new Date(Date.now() - 1000) } },
        );
      expect((await login('bloqueo')).status).toBe(200);
      const despues = await userDoc('bloqueo');
      expect(despues?.failedLoginAttempts).toBe(0);
      expect(despues?.lockedUntil).toBeUndefined();
    });
  });

  describe('aprobación de PROVEEDOR', () => {
    it('queda PENDING_APPROVAL y su login con contraseña correcta da 403 sin tokens', async () => {
      const reg = await register('prov-pend', 'PROVEEDOR');
      expect(reg.status).toBe(201);
      expect(reg.body.status).toBe('PENDING_APPROVAL');

      const res = await login('prov-pend');
      expect(res.status).toBe(403);
      expect(res.body.accessToken).toBeUndefined();
      expect(res.body.refreshToken).toBeUndefined();
    });

    it('con la contraseña incorrecta el estado no se filtra (401)', async () => {
      await register('prov-oculto', 'PROVEEDOR');
      expect((await login('prov-oculto', 'Incorrecta123')).status).toBe(401);
    });

    it('approve: el PROVEEDOR inicia sesión y se emite provider.approved', async () => {
      const reg = await register('prov-ok', 'PROVEEDOR');
      const escucha = vi.fn();
      events.once('provider.approved', escucha);

      const res = await call('post', `/auth/users/${reg.body.id}/approve`, {
        token: adminToken,
      });

      expect(res.status).toBe(200);
      expect(res.body.status).toBe('ACTIVE');
      expect(escucha).toHaveBeenCalledWith({
        userId: reg.body.id,
        email: email('prov-ok'),
        reviewedBy: adminId,
      });
      expect((await login('prov-ok')).status).toBe(200);
    });

    it('reject: login 403, queda el motivo, evento y no puede registrarse otra vez (409)', async () => {
      const reg = await register('prov-no', 'PROVEEDOR');
      const escucha = vi.fn();
      events.once('provider.rejected', escucha);

      const res = await call('post', `/auth/users/${reg.body.id}/reject`, {
        token: adminToken,
        body: { reason: 'Documento ilegible' },
      });

      expect(res.status).toBe(200);
      expect(escucha).toHaveBeenCalledWith({
        userId: reg.body.id,
        email: email('prov-no'),
        reviewedBy: adminId,
        reason: 'Documento ilegible',
      });
      expect((await login('prov-no')).status).toBe(403);
      const detalle = await call('get', `/auth/users/${reg.body.id}`, {
        token: adminToken,
      });
      expect(detalle.body).toMatchObject({
        status: 'REJECTED',
        rejectionReason: 'Documento ilegible',
        reviewedBy: adminId,
      });
      expect((await register('prov-no', 'PROVEEDOR')).status).toBe(409);
    });

    it('approve sobre un usuario que no es un PROVEEDOR pendiente responde 409', async () => {
      const reg = await register('prod-aprobar');
      const res = await call('post', `/auth/users/${reg.body.id}/approve`, {
        token: adminToken,
      });
      expect(res.status).toBe(409);
    });
  });

  describe('roles', () => {
    it('PRODUCTOR y PROVEEDOR reciben 403 en /auth/users; ADMIN recibe 200', async () => {
      const prod = await registerAndLogin('rol-prod');
      const prov = await register('rol-prov', 'PROVEEDOR');
      const reg = await call('post', `/auth/users/${prov.body.id}/approve`, {
        token: adminToken,
      });
      expect(reg.status).toBe(200);
      const provToken = (await login('rol-prov')).body.accessToken;

      expect(
        (await call('get', '/auth/users', { token: prod.accessToken })).status,
      ).toBe(403);
      expect(
        (await call('get', '/auth/users', { token: provToken })).status,
      ).toBe(403);
      const admin = await call('get', '/auth/users?limit=5', {
        token: adminToken,
      });
      expect(admin.status).toBe(200);
      expect(admin.body.data.length).toBeLessThanOrEqual(5);
      expect(JSON.stringify(admin.body)).not.toMatch(/passwordHash/);
    });

    it('el listado filtra por rol y status, y limita el tamaño de página', async () => {
      await register('filtro', 'PROVEEDOR');
      const res = await call(
        'get',
        '/auth/users?rol=PROVEEDOR&status=PENDING_APPROVAL&limit=100',
        { token: adminToken },
      );
      expect(res.status).toBe(200);
      expect(
        res.body.data.every(
          (u: Json) => u.rol === 'PROVEEDOR' && u.status === 'PENDING_APPROVAL',
        ),
      ).toBe(true);
      expect(
        (await call('get', '/auth/users?limit=101', { token: adminToken }))
          .status,
      ).toBe(400);
    });
  });

  describe('sesión: refresh, logout y cambio de contraseña', () => {
    it('refresh rota el token; reutilizar el anterior da 401 y revoca toda la familia', async () => {
      const { refreshToken: r1 } = await registerAndLogin('rotacion');

      const rotado = await refresh(r1);
      expect(rotado.status).toBe(200);
      const r2 = rotado.body.refreshToken as string;
      expect(r2).not.toBe(r1);

      const hashes = await conn
        .collection('refresh_tokens')
        .find({
          tokenHash: sha256(r1),
        })
        .toArray();
      expect(hashes[0].revokedAt).toBeInstanceOf(Date);

      expect((await refresh(r1)).status).toBe(401);
      expect((await refresh(r2)).status).toBe(401); // la familia quedó revocada
    });

    it('en refresh_tokens solo existe el hash: el token en claro no está en la base', async () => {
      const { id, refreshToken } = await registerAndLogin('hash');

      const docs = await conn
        .collection('refresh_tokens')
        .find({ userId: new (await import('mongoose')).Types.ObjectId(id) })
        .toArray();
      expect(docs).toHaveLength(1);
      expect(docs[0].tokenHash).toBe(sha256(refreshToken));
      expect(JSON.stringify(docs)).not.toContain(refreshToken);
      expect(Object.keys(docs[0])).not.toContain('token');
    });

    it('logout revoca la sesión: su refresh token ya no sirve', async () => {
      const { accessToken, refreshToken } = await registerAndLogin('logout');

      expect(
        (await call('post', '/auth/logout', { token: accessToken })).status,
      ).toBe(204);
      expect((await refresh(refreshToken)).status).toBe(401);
    });

    it('GET /auth/me devuelve el perfil sin hash ni documento', async () => {
      const { accessToken } = await registerAndLogin('perfil');
      const res = await call('get', '/auth/me', { token: accessToken });

      expect(res.status).toBe(200);
      expect(res.body.email).toBe(email('perfil'));
      expect(JSON.stringify(res.body)).not.toMatch(/passwordHash|hash/i);
      expect(JSON.stringify(res.body)).not.toContain(DOCUMENTO);
    });

    it('change-password: la actual errónea da 401; la correcta revoca todos los refresh', async () => {
      const sesion1 = await registerAndLogin('cambio');
      const sesion2 = (await login('cambio')).body.refreshToken as string;
      const cambio = (current: string, next = 'Nueva123456') =>
        call('post', '/auth/change-password', {
          token: sesion1.accessToken,
          body: { currentPassword: current, newPassword: next },
        });

      expect((await cambio('Incorrecta123')).status).toBe(401);
      expect((await cambio(PASSWORD, 'abc')).status).toBe(400);
      expect((await refresh(sesion1.refreshToken)).status).toBe(200); // sin efecto hasta aquí

      const ok = await cambio(PASSWORD);
      expect(ok.status).toBe(204);
      expect((await userDoc('cambio'))?.passwordChangedAt).toBeInstanceOf(Date);
      expect((await refresh(sesion1.refreshToken)).status).toBe(401);
      expect((await refresh(sesion2)).status).toBe(401);
      expect((await login('cambio')).status).toBe(401);
      expect((await login('cambio', 'Nueva123456')).status).toBe(200);
    });
  });

  describe('administración de usuarios', () => {
    it('disable revoca sus refresh tokens y su login pasa a 403; enable lo restablece', async () => {
      const u = await registerAndLogin('deshabilitar');

      const res = await call('post', `/auth/users/${u.id}/disable`, {
        token: adminToken,
      });
      expect(res.status).toBe(200);
      expect(res.body.status).toBe('DISABLED');
      expect((await refresh(u.refreshToken)).status).toBe(401);
      expect((await login('deshabilitar')).status).toBe(403);

      expect(
        (
          await call('post', `/auth/users/${u.id}/enable`, {
            token: adminToken,
          })
        ).status,
      ).toBe(200);
      expect((await login('deshabilitar')).status).toBe(200);
    });

    it('un ADMIN que intenta deshabilitarse o cambiarse el rol recibe 403', async () => {
      const disable = await call('post', `/auth/users/${adminId}/disable`, {
        token: adminToken,
      });
      const role = await call('patch', `/auth/users/${adminId}/role`, {
        token: adminToken,
        body: { rol: 'PRODUCTOR' },
      });
      expect(disable.status).toBe(403);
      expect(role.status).toBe(403);
      expect(
        (await call('get', '/auth/me', { token: adminToken })).status,
      ).toBe(200);
    });

    it('cambiar el rol revoca los refresh tokens del usuario', async () => {
      const u = await registerAndLogin('promovido');

      const res = await call('patch', `/auth/users/${u.id}/role`, {
        token: adminToken,
        body: { rol: 'ADMIN' },
      });

      expect(res.status).toBe(200);
      expect(res.body.rol).toBe('ADMIN');
      expect((await refresh(u.refreshToken)).status).toBe(401);
      const nuevo = await login('promovido');
      expect(signer.decode(nuevo.body.accessToken)).toMatchObject({
        rol: 'ADMIN',
      });
    });
  });

  describe('límites de peticiones', () => {
    it('6 peticiones seguidas a /auth/login desde la misma IP: la sexta da 429', async () => {
      const ip = nextIp();
      const estados: number[] = [];
      for (let i = 0; i < 6; i++) {
        const res = await call('post', '/auth/login', {
          ip,
          body: { email: email('nadie'), password: PASSWORD },
        });
        estados.push(res.status);
      }
      expect(estados).toEqual([401, 401, 401, 401, 401, 429]);
    });

    it('101 peticiones a cualquier ruta en un minuto: la 101 da 429', async () => {
      const ip = nextIp();
      let ultimo = 0;
      let primeros = new Set<number>();
      for (let i = 0; i < 101; i++) {
        ultimo = (await call('get', '/catalog', { ip })).status;
        if (i < 100) primeros.add(ultimo);
      }
      expect([...primeros]).toEqual([401]);
      expect(ultimo).toBe(429);
    });
  });

  describe('cabeceras HTTP y CORS', () => {
    it('incluye las cabeceras de helmet y no X-Powered-By', async () => {
      const res = await call('get', '/health');
      expect(res.headers['x-content-type-options']).toBe('nosniff');
      expect(res.headers['strict-transport-security']).toBeDefined();
      expect(res.headers['x-powered-by']).toBeUndefined();
    });

    it('un Origin fuera de CORS_ORIGINS no recibe Access-Control-Allow-Origin', async () => {
      const res = await call('get', '/health', {
        headers: { Origin: 'http://evil.com' },
      });
      expect(res.headers['access-control-allow-origin']).toBeUndefined();
    });

    it('un Origin de la lista blanca sí lo recibe', async () => {
      const res = await call('get', '/health', {
        headers: { Origin: ALLOWED_ORIGIN },
      });
      expect(res.headers['access-control-allow-origin']).toBe(ALLOWED_ORIGIN);
    });
  });

  describe('Swagger', () => {
    it('fuera de producción documenta el esquema bearer', async () => {
      const res = await call('get', '/docs-json');
      expect(res.status).toBe(200);
      expect(res.body.components.securitySchemes).toMatchObject({
        bearer: { type: 'http', scheme: 'bearer' },
      });
    });

    it('con NODE_ENV=production la ruta de Swagger responde 404', async () => {
      const anterior = process.env.NODE_ENV;
      process.env.NODE_ENV = 'production';
      let pequena: INestApplication | undefined;
      try {
        const moduleRef = await Test.createTestingModule({}).compile();
        pequena = moduleRef.createNestApplication();
        setupSwagger(pequena, { title: 'prod', description: 'prod' });
        await pequena.init();
        expect(
          (await request(pequena.getHttpServer()).get('/docs')).status,
        ).toBe(404);
        expect(
          (await request(pequena.getHttpServer()).get('/docs-json')).status,
        ).toBe(404);
      } finally {
        process.env.NODE_ENV = anterior;
        await pequena?.close();
      }
    });
  });

  describe('logs', () => {
    it('ningún log contiene contraseñas, tokens ni el documento completo', () => {
      const salida = logs.join('');
      expect(salida.length).toBeGreaterThan(0); // la captura funciona
      expect(salida).not.toContain(PASSWORD);
      expect(salida).not.toContain(DOCUMENTO);
      expect(issuedTokens.size).toBeGreaterThan(10);
      for (const token of issuedTokens) {
        expect(salida).not.toContain(token);
      }
    });
  });
});

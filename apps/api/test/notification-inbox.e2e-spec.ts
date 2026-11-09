// E2E de la bandeja de avisos (SPEC 11): `api` y `notifications` corren en el mismo proceso
// contra MongoDB y RabbitMQ reales, y `api` lee los avisos por HTTP desde `notifications`.
//
// - Necesita MONGODB_URI y RABBITMQ_URI: `docker compose up -d --wait`.
// - Los tokens se firman con un par RSA propio de la suite (no hay usuarios en la base), y
//   los avisos de prueba cuelgan de ids aleatorios que se borran al terminar.
// - Un `notifications` caída, lenta o con token malo se simula cambiando el lector del
//   servicio por uno que apunta a otra parte; el resto de `api` es el real.
import { generateKeyPairSync, randomUUID } from 'node:crypto';
import { createServer, type Server } from 'node:http';
import { createServer as createNetServer } from 'node:net';
import { JwtService } from '@nestjs/jwt';
import { getConnectionToken } from '@nestjs/mongoose';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { Test } from '@nestjs/testing';
import { type Connection, Types } from 'mongoose';
import request from 'supertest';

// Deben fijarse antes de importar `ApiModule` (el entorno se valida al evaluarlo).
const keys = generateKeyPairSync('rsa', {
  modulusLength: 2048,
  privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
  publicKeyEncoding: { type: 'spki', format: 'pem' },
});
process.env.JWT_PRIVATE_KEY = keys.privateKey;
process.env.JWT_PUBLIC_KEY = keys.publicKey;
process.env.PAYMENTS_WEBHOOK_SECRET = 'e2e-webhook-secret-0123456789abcdef';
process.env.CORS_ORIGINS = '';

/** Un puerto libre: se reserva y se suelta. */
const freePort = () =>
  new Promise<number>((resolve, reject) => {
    const server = createNetServer();
    server.once('error', reject);
    server.listen(0, () => {
      const { port } = server.address() as { port: number };
      server.close(() => resolve(port));
    });
  });

const NOTIFICATIONS_PORT = await freePort();
process.env.NOTIFICATIONS_INTERNAL_URL = `http://127.0.0.1:${NOTIFICATIONS_PORT}`;

type Json = Record<string, any>;
type Rol = 'PRODUCTOR' | 'PROVEEDOR' | 'ADMIN';

describe('bandeja de avisos (e2e)', () => {
  let api: NestExpressApplication;
  let notifications: NestExpressApplication;
  let nconn: Connection; // base `mini-croper-notifications`
  let jwt: JwtService;
  const ids: Types.ObjectId[] = [];

  let ipCounter = 0;
  const nextIp = () => `10.70.0.${++ipCounter}`;

  const newId = () => {
    const id = new Types.ObjectId();
    ids.push(id);
    return id;
  };

  const tokenOf = (rol: Rol, id: Types.ObjectId, storeId?: Types.ObjectId) =>
    jwt.sign({
      sub: id.toString(),
      rol,
      sid: randomUUID(),
      ...(storeId && { storeId: storeId.toString() }),
    });

  const call = (
    method: 'get' | 'post' | 'patch',
    path: string,
    token?: string,
    query?: Json,
  ) => {
    let req = request(api.getHttpServer())
      [method](path)
      .set('X-Forwarded-For', nextIp());
    if (token) req = req.set('Authorization', `Bearer ${token}`);
    return query ? req.query(query) : req;
  };

  const aviso = (
    destinatarioTipo: 'USER' | 'STORE',
    destinatarioId: Types.ObjectId,
    over: Json = {},
  ) => ({
    _id: new Types.ObjectId(),
    eventId: randomUUID(),
    eventType: 'payment.approved',
    correlationId: new Types.ObjectId().toString(),
    destinatarioTipo,
    destinatarioId,
    plantilla: 'PAYMENT_APPROVED',
    titulo: 'Pago aprobado',
    mensaje: 'Tu pago fue aprobado',
    canal: 'SIMULATED',
    sentAt: new Date(),
    createdAt: new Date(),
    ...over,
  });

  const insertar = async (docs: ReturnType<typeof aviso>[]) => {
    await nconn.collection('notifications').insertMany(docs);
    return docs.map((d) => String(d._id));
  };

  const idsDe = (body: Json) => body.data.map((a: Json) => a.id);

  beforeAll(async () => {
    const { ApiModule } = await import('../src/api.module.js');
    const { NotificationsModule } =
      await import('../../notifications/src/notifications.module.js');
    const { applySecurity } =
      await import('../../../libs/common/src/security/apply-security.js');

    const apiRef = await Test.createTestingModule({
      imports: [ApiModule],
    }).compile();
    api = apiRef.createNestApplication<NestExpressApplication>({
      rawBody: true,
    });
    api.set('trust proxy', true);
    applySecurity(api, { corsOrigins: [] });
    await api.init();

    const notifRef = await Test.createTestingModule({
      imports: [NotificationsModule],
    }).compile();
    notifications = notifRef.createNestApplication<NestExpressApplication>();
    applySecurity(notifications, { corsOrigins: [] });
    await notifications.listen(NOTIFICATIONS_PORT, '127.0.0.1');
    nconn = notifications.get<Connection>(getConnectionToken());

    jwt = new JwtService({
      privateKey: keys.privateKey,
      signOptions: {
        algorithm: 'RS256',
        issuer: 'mini-croper',
        audience: 'mini-croper-api',
        expiresIn: '15m',
      },
    });
  });

  afterAll(async () => {
    await nconn
      .collection('notifications')
      .deleteMany({ destinatarioId: { $in: ids } });
    await notifications.close();
    await api.close();
  });

  describe('autenticación y roles', () => {
    const id = new Types.ObjectId().toString();
    const rutas = [
      ['get', '/notifications'],
      ['get', '/notifications/unread-count'],
      ['post', '/notifications/read-all'],
      ['patch', `/notifications/${id}/read`],
    ] as const;

    it.each(rutas)('%s %s responde 401 sin token', async (method, url) => {
      await call(method, url).expect(401);
    });

    it.each(rutas)('%s %s responde 403 al ADMIN', async (method, url) => {
      await call(method, url, tokenOf('ADMIN', new Types.ObjectId())).expect(
        403,
      );
    });
  });

  describe('visibilidad', () => {
    it('un PRODUCTOR ve sus avisos y no los de otro', async () => {
      const ana = newId();
      const beto = newId();
      const [deAna, deBeto] = await insertar([
        aviso('USER', ana),
        aviso('USER', beto),
      ]);

      const deAnaRes = await call(
        'get',
        '/notifications',
        tokenOf('PRODUCTOR', ana),
      ).expect(200);
      const deBetoRes = await call(
        'get',
        '/notifications',
        tokenOf('PRODUCTOR', beto),
      ).expect(200);

      expect(idsDe(deAnaRes.body)).toEqual([deAna]);
      expect(idsDe(deBetoRes.body)).toEqual([deBeto]);
    });

    it('un PROVEEDOR ve sus USER y los STORE de su tienda, no los de otra tienda', async () => {
      const prov = newId();
      const otro = newId();
      const tienda = newId();
      const otraTienda = newId();
      const [propio, deTienda, deOtra] = await insertar([
        aviso('USER', prov),
        aviso('STORE', tienda),
        aviso('STORE', otraTienda),
      ]);

      const conTienda = await call(
        'get',
        '/notifications',
        tokenOf('PROVEEDOR', prov, tienda),
      ).expect(200);
      expect(idsDe(conTienda.body)).toEqual([deTienda, propio]);

      const deOtroProveedor = await call(
        'get',
        '/notifications',
        tokenOf('PROVEEDOR', otro, otraTienda),
      ).expect(200);
      expect(idsDe(deOtroProveedor.body)).toEqual([deOtra]);
    });

    it('un PROVEEDOR sin storeId en el token solo ve sus USER', async () => {
      const prov = newId();
      const tienda = newId();
      const [propio] = await insertar([
        aviso('USER', prov),
        aviso('STORE', tienda),
      ]);

      const res = await call(
        'get',
        '/notifications',
        tokenOf('PROVEEDOR', prov),
      ).expect(200);

      expect(idsDe(res.body)).toEqual([propio]);
    });

    it('un PRODUCTOR no ve avisos STORE aunque su token traiga storeId', async () => {
      const ana = newId();
      const tienda = newId();
      await insertar([aviso('STORE', tienda)]);

      const res = await call(
        'get',
        '/notifications',
        tokenOf('PRODUCTOR', ana, tienda),
      ).expect(200);

      expect(res.body).toEqual({ data: [], nextCursor: null });
    });

    it('la vista solo trae los campos públicos', async () => {
      const ana = newId();
      const correlationId = new Types.ObjectId().toString();
      await insertar([
        aviso('USER', ana, {
          eventType: 'user.registered',
          plantilla: 'USER_REGISTERED',
        }),
        aviso('USER', ana, { correlationId }),
      ]);

      const res = await call(
        'get',
        '/notifications',
        tokenOf('PRODUCTOR', ana),
      ).expect(200);

      const [pago, cuenta] = res.body.data;
      expect(Object.keys(pago).sort()).toEqual(
        [
          'id',
          'plantilla',
          'destinatarioTipo',
          'titulo',
          'mensaje',
          'orderId',
          'sentAt',
          'readAt',
        ].sort(),
      );
      expect(pago.orderId).toBe(correlationId);
      expect(cuenta.orderId).toBeNull();
      expect(pago.readAt).toBeNull();
    });
  });

  describe('paginación', () => {
    it('pagina por cursor sin repetir ni omitir, aunque lleguen avisos nuevos', async () => {
      const ana = newId();
      const token = tokenOf('PRODUCTOR', ana);
      const creados = await insertar(
        Array.from({ length: 5 }, () => aviso('USER', ana)),
      );
      const esperados = [...creados].reverse();

      const p1 = await call('get', '/notifications', token, {
        limit: 2,
      }).expect(200);
      expect(idsDe(p1.body)).toEqual(esperados.slice(0, 2));

      await insertar([aviso('USER', ana)]); // llega uno nuevo entre páginas

      const p2 = await call('get', '/notifications', token, {
        limit: 2,
        cursor: p1.body.nextCursor,
      }).expect(200);
      expect(idsDe(p2.body)).toEqual(esperados.slice(2, 4));

      const p3 = await call('get', '/notifications', token, {
        limit: 2,
        cursor: p2.body.nextCursor,
      }).expect(200);
      expect(idsDe(p3.body)).toEqual(esperados.slice(4));
      expect(p3.body.nextCursor).toBeNull();
    });

    it('usa limit 20 por defecto', async () => {
      const ana = newId();
      await insertar(Array.from({ length: 21 }, () => aviso('USER', ana)));

      const res = await call(
        'get',
        '/notifications',
        tokenOf('PRODUCTOR', ana),
      ).expect(200);

      expect(res.body.data).toHaveLength(20);
      expect(res.body.nextCursor).not.toBeNull();
    });

    it('responde 400 con limit fuera de rango, ids inválidos o propiedades de más', async () => {
      const ana = newId();
      const token = tokenOf('PRODUCTOR', ana);
      for (const query of [
        { limit: 0 },
        { limit: 51 },
        { cursor: 'abc' },
        { userId: ana.toString() },
        { storeId: ana.toString() },
        { page: 1 },
      ]) {
        await call('get', '/notifications', token, query).expect(400);
      }
      await call('patch', '/notifications/no-es-id/read', token).expect(400);
    });
  });

  describe('estado de lectura', () => {
    it('unread-count cuenta solo los visibles sin leer y baja al marcar leídos', async () => {
      const prov = newId();
      const tienda = newId();
      const [primero] = await insertar([
        aviso('USER', prov),
        aviso('USER', prov),
        aviso('STORE', tienda),
        aviso('USER', prov, { readAt: new Date() }),
      ]);
      const token = tokenOf('PROVEEDOR', prov, tienda);

      await call('get', '/notifications/unread-count', token).expect(200, {
        count: 3,
      });
      await call('patch', `/notifications/${primero}/read`, token).expect(200);
      await call('get', '/notifications/unread-count', token).expect(200, {
        count: 2,
      });
    });

    it('PATCH :id/read es idempotente: repetirlo no cambia readAt', async () => {
      const ana = newId();
      const token = tokenOf('PRODUCTOR', ana);
      const [id] = await insertar([aviso('USER', ana)]);

      const primera = await call(
        'patch',
        `/notifications/${id}/read`,
        token,
      ).expect(200);
      expect(primera.body.readAt).not.toBeNull();

      await new Promise((resolve) => setTimeout(resolve, 20));
      const segunda = await call(
        'patch',
        `/notifications/${id}/read`,
        token,
      ).expect(200);
      expect(segunda.body.readAt).toBe(primera.body.readAt);
    });

    it('un id ajeno o inexistente da 404 y no se marca', async () => {
      const ana = newId();
      const beto = newId();
      const tienda = newId();
      const otraTienda = newId();
      const [deAna, deTienda] = await insertar([
        aviso('USER', ana),
        aviso('STORE', tienda),
      ]);

      await call(
        'patch',
        `/notifications/${deAna}/read`,
        tokenOf('PRODUCTOR', beto),
      ).expect(404);
      // Un proveedor de otra tienda no marca un aviso STORE ajeno aunque conozca el id.
      await call(
        'patch',
        `/notifications/${deTienda}/read`,
        tokenOf('PROVEEDOR', beto, otraTienda),
      ).expect(404);
      await call(
        'patch',
        `/notifications/${new Types.ObjectId().toString()}/read`,
        tokenOf('PRODUCTOR', ana),
      ).expect(404);

      const docs = await nconn
        .collection('notifications')
        .find({
          _id: { $in: [deAna, deTienda].map((x) => new Types.ObjectId(x)) },
        })
        .toArray();
      expect(docs.every((d) => d.readAt === undefined)).toBe(true);
    });

    it('read-all marca solo los del actor y la segunda llamada devuelve 0', async () => {
      const ana = newId();
      const beto = newId();
      await insertar([
        aviso('USER', ana),
        aviso('USER', ana),
        aviso('USER', ana, { readAt: new Date() }),
        aviso('USER', beto),
      ]);

      await call(
        'post',
        '/notifications/read-all',
        tokenOf('PRODUCTOR', ana),
      ).expect(200, { updated: 2 });
      await call(
        'post',
        '/notifications/read-all',
        tokenOf('PRODUCTOR', ana),
      ).expect(200, { updated: 0 });

      await call(
        'get',
        '/notifications/unread-count',
        tokenOf('PRODUCTOR', beto),
      ).expect(200, { count: 1 });
    });
  });

  describe('notifications no disponible', () => {
    /** Cambia el lector del servicio por uno con otra URL o token y lo restaura al final. */
    async function conLector(
      url: string,
      token: string | undefined,
      fn: () => Promise<void>,
    ) {
      const { NotificationInboxService } =
        await import('../src/modules/notification-inbox/services/notification-inbox.service.js');
      const { HttpNotificationsReader } =
        await import('../src/modules/notification-inbox/services/http-notifications-reader.service.js');
      const service = api.get(NotificationInboxService, { strict: false }) as {
        reader: unknown;
      };
      const original = service.reader;
      const config = {
        get: (key: string) =>
          key === 'NOTIFICATIONS_INTERNAL_URL'
            ? url
            : (token ?? process.env.INTERNAL_SERVICE_TOKEN),
      };
      service.reader = new HttpNotificationsReader(config as never);
      try {
        await fn();
      } finally {
        service.reader = original;
      }
    }

    /** 503 en las rutas de avisos y el resto de `api` intacto. */
    async function rutasVivas(token: string) {
      await call('get', '/notifications', token).expect(503);
      await call('get', '/notifications/unread-count', token).expect(503);
      await call('post', '/notifications/read-all', token).expect(503);
      await call('get', '/health').expect(200);
      await call('get', '/catalog/products').expect(200);
    }

    it('con el puerto cerrado responde 503 y el resto de api sigue en 200', async () => {
      const cerrado = await freePort();
      const token = tokenOf('PRODUCTOR', newId());
      await conLector(`http://127.0.0.1:${cerrado}`, undefined, () =>
        rutasVivas(token),
      );
    });

    it('con un token de servicio mal configurado responde 503, no 401', async () => {
      const token = tokenOf('PRODUCTOR', newId());
      await conLector(
        process.env.NOTIFICATIONS_INTERNAL_URL!,
        'x'.repeat(40),
        async () => {
          const res = await call('get', '/notifications', token).expect(503);
          expect(JSON.stringify(res.body)).not.toContain('x'.repeat(40));
          await call('get', '/health').expect(200);
        },
      );
    });

    it('con notifications lenta (más de 3 s) responde 503', async () => {
      const lento: Server = createServer(() => {
        // Nunca responde.
      });
      await new Promise<void>((resolve) =>
        lento.listen(0, '127.0.0.1', resolve),
      );
      const { port } = lento.address() as { port: number };
      const token = tokenOf('PRODUCTOR', newId());
      try {
        await conLector(`http://127.0.0.1:${port}`, undefined, async () => {
          const inicio = Date.now();
          await call('get', '/notifications', token).expect(503);
          expect(Date.now() - inicio).toBeGreaterThanOrEqual(2_900);
          await call('get', '/health').expect(200);
        });
      } finally {
        lento.closeAllConnections();
        await new Promise((resolve) => lento.close(resolve));
      }
    });
  });
});

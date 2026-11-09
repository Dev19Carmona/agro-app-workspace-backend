// E2E de la API interna de `notifications` (/internal/*) contra MongoDB y RabbitMQ reales:
// token de servicio, listado por cursor, aislamiento entre actores y estado de lectura.
//
// - Necesita MONGODB_URI y RABBITMQ_URI (entorno o `.env`): `docker compose up -d --wait`.
// - Los avisos de prueba cuelgan de ids aleatorios y se borran al terminar.
import { randomUUID } from 'node:crypto';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { getConnectionToken } from '@nestjs/mongoose';
import { Test } from '@nestjs/testing';
import { type Connection, Types } from 'mongoose';
import request from 'supertest';
import { applySecurity } from '../../../libs/common/src/security/apply-security.js';
import { NotificationsModule } from '../src/notifications.module.js';

const TOKEN = process.env.INTERNAL_SERVICE_TOKEN!;

describe('notifications API interna (e2e)', () => {
  let app: NestExpressApplication;
  let conn: Connection;
  const ids: Types.ObjectId[] = [];

  const newId = () => {
    const id = new Types.ObjectId();
    ids.push(id);
    return id;
  };

  const aviso = (
    destinatarioTipo: 'USER' | 'STORE',
    destinatarioId: Types.ObjectId,
    over: Record<string, unknown> = {},
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
    await conn.collection('notifications').insertMany(docs);
    return docs.map((doc) => String(doc._id));
  };

  const http = () => request(app.getHttpServer());
  const conToken = (r: request.Test) => r.set('X-Service-Token', TOKEN);

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [NotificationsModule],
    }).compile();
    app = moduleRef.createNestApplication<NestExpressApplication>();
    applySecurity(app, { corsOrigins: [] });
    await app.init();
    conn = app.get<Connection>(getConnectionToken());
  });

  afterAll(async () => {
    await conn
      .collection('notifications')
      .deleteMany({ destinatarioId: { $in: ids } });
    await app.close();
  });

  describe('token de servicio', () => {
    const userId = new Types.ObjectId().toString();
    const id = new Types.ObjectId().toString();

    it.each([
      ['get', '/internal/notifications'],
      ['get', '/internal/notifications/unread-count'],
      ['post', '/internal/notifications/read-all'],
      ['patch', `/internal/notifications/${id}/read`],
    ] as const)('%s %s responde 401 sin token', async (method, url) => {
      await http()[method](url).query({ userId }).send({ userId }).expect(401);
    });

    it('responde 401 con un token distinto, de otro largo o repetido', async () => {
      for (const token of [
        'x'.repeat(TOKEN.length),
        'x',
        `${TOKEN}, ${TOKEN}`,
      ]) {
        await http()
          .get('/internal/notifications')
          .set('X-Service-Token', token)
          .query({ userId })
          .expect(401);
      }
    });

    it('el 401 no revela detalle ni el token', async () => {
      const res = await http()
        .get('/internal/notifications')
        .set('X-Service-Token', 'x')
        .query({ userId })
        .expect(401);
      expect(JSON.stringify(res.body)).not.toContain(TOKEN);
    });

    it('GET /health sigue respondiendo 200 sin token', async () => {
      await http().get('/health').expect(200);
    });
  });

  describe('endurecimiento HTTP', () => {
    it('envía cabeceras de helmet, sin X-Powered-By ni CORS', async () => {
      const res = await http()
        .get('/health')
        .set('Origin', 'http://evil.example')
        .expect(200);
      expect(res.headers['x-content-type-options']).toBe('nosniff');
      expect(res.headers['x-powered-by']).toBeUndefined();
      expect(res.headers['access-control-allow-origin']).toBeUndefined();
    });

    it('rechaza un body de más de 100 kb', async () => {
      const grande = {
        userId: new Types.ObjectId().toString(),
        x: 'a'.repeat(150_000),
      };
      const res = await conToken(
        http().post('/internal/notifications/read-all'),
      ).send(grande);
      expect(res.status).toBe(413);
    });
  });

  describe('listado por cursor', () => {
    it('ordena del más nuevo al más viejo y pagina sin repetir ni omitir', async () => {
      const userId = newId();
      const creados = await insertar(
        Array.from({ length: 5 }, () => aviso('USER', userId)),
      );
      const esperados = [...creados].reverse();
      const actor = { userId: userId.toString() };

      const p1 = await conToken(http().get('/internal/notifications'))
        .query({ ...actor, limit: 2 })
        .expect(200);
      expect(p1.body.data.map((a: { id: string }) => a.id)).toEqual(
        esperados.slice(0, 2),
      );
      expect(p1.body.nextCursor).toBe(esperados[1]);

      // Llega un aviso nuevo entre páginas: no desplaza la segunda página.
      await insertar([aviso('USER', userId)]);

      const p2 = await conToken(http().get('/internal/notifications'))
        .query({ ...actor, limit: 2, cursor: p1.body.nextCursor })
        .expect(200);
      expect(p2.body.data.map((a: { id: string }) => a.id)).toEqual(
        esperados.slice(2, 4),
      );

      const p3 = await conToken(http().get('/internal/notifications'))
        .query({ ...actor, limit: 2, cursor: p2.body.nextCursor })
        .expect(200);
      expect(p3.body.data.map((a: { id: string }) => a.id)).toEqual(
        esperados.slice(4),
      );
      expect(p3.body.nextCursor).toBeNull();
    });

    it('un PROVEEDOR ve sus USER y los STORE de su tienda, no los de otra', async () => {
      const userId = newId();
      const storeId = newId();
      const otraTienda = newId();
      const [propio, deTienda, deOtra] = await insertar([
        aviso('USER', userId),
        aviso('STORE', storeId),
        aviso('STORE', otraTienda),
      ]);

      const conTienda = await conToken(http().get('/internal/notifications'))
        .query({ userId: userId.toString(), storeId: storeId.toString() })
        .expect(200);
      expect(conTienda.body.data.map((a: { id: string }) => a.id)).toEqual([
        deTienda,
        propio,
      ]);

      const sinTienda = await conToken(http().get('/internal/notifications'))
        .query({ userId: userId.toString() })
        .expect(200);
      expect(sinTienda.body.data.map((a: { id: string }) => a.id)).toEqual([
        propio,
      ]);
      expect(JSON.stringify([conTienda.body, sinTienda.body])).not.toContain(
        deOtra,
      );
    });

    it('no ve los avisos de otro usuario', async () => {
      const ana = newId();
      const beto = newId();
      await insertar([aviso('USER', ana)]);

      const res = await conToken(http().get('/internal/notifications'))
        .query({ userId: beto.toString() })
        .expect(200);
      expect(res.body).toEqual({ data: [], nextCursor: null });
    });

    it('la vista solo trae los campos públicos y orderId según el evento', async () => {
      const userId = newId();
      const correlationId = new Types.ObjectId().toString();
      await insertar([
        aviso('USER', userId, {
          eventType: 'provider.approved',
          plantilla: 'PROVIDER_APPROVED',
        }),
        aviso('USER', userId, { correlationId }),
      ]);

      const res = await conToken(http().get('/internal/notifications'))
        .query({ userId: userId.toString() })
        .expect(200);

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

    it('responde 400 con limit fuera de rango, ids inválidos o propiedades de más', async () => {
      const userId = new Types.ObjectId().toString();
      for (const query of [
        { userId, limit: 0 },
        { userId, limit: 51 },
        { userId, cursor: 'x' },
        { userId: 'x' },
        { userId, extra: 1 },
        {},
      ]) {
        await conToken(http().get('/internal/notifications'))
          .query(query)
          .expect(400);
      }
    });
  });

  describe('estado de lectura', () => {
    it('unread-count cuenta solo los visibles sin leer y baja al leer', async () => {
      const userId = newId();
      const storeId = newId();
      const [primero] = await insertar([
        aviso('USER', userId),
        aviso('USER', userId),
        aviso('STORE', storeId),
        aviso('USER', userId, { readAt: new Date() }),
      ]);
      const actor = { userId: userId.toString() };
      const conTienda = { ...actor, storeId: storeId.toString() };

      await conToken(http().get('/internal/notifications/unread-count'))
        .query(actor)
        .expect(200, { count: 2 });
      await conToken(http().get('/internal/notifications/unread-count'))
        .query(conTienda)
        .expect(200, { count: 3 });

      await conToken(http().patch(`/internal/notifications/${primero}/read`))
        .send(actor)
        .expect(200);

      await conToken(http().get('/internal/notifications/unread-count'))
        .query(actor)
        .expect(200, { count: 1 });
    });

    it('PATCH :id/read es idempotente: repetirlo no cambia readAt', async () => {
      const userId = newId();
      const [id] = await insertar([aviso('USER', userId)]);
      const actor = { userId: userId.toString() };

      const primera = await conToken(
        http().patch(`/internal/notifications/${id}/read`),
      )
        .send(actor)
        .expect(200);
      expect(primera.body.readAt).not.toBeNull();

      await new Promise((resolve) => setTimeout(resolve, 20));
      const segunda = await conToken(
        http().patch(`/internal/notifications/${id}/read`),
      )
        .send(actor)
        .expect(200);
      expect(segunda.body.readAt).toBe(primera.body.readAt);
    });

    it('un id ajeno o inexistente da 404 y no se marca', async () => {
      const ana = newId();
      const beto = newId();
      const tiendaDeAna = newId();
      const [deAna, deTienda] = await insertar([
        aviso('USER', ana),
        aviso('STORE', tiendaDeAna),
      ]);

      await conToken(http().patch(`/internal/notifications/${deAna}/read`))
        .send({ userId: beto.toString() })
        .expect(404);
      // Un aviso STORE tampoco se marca sin la tienda en el actor.
      await conToken(http().patch(`/internal/notifications/${deTienda}/read`))
        .send({ userId: ana.toString() })
        .expect(404);
      await conToken(
        http().patch(
          `/internal/notifications/${new Types.ObjectId().toString()}/read`,
        ),
      )
        .send({ userId: ana.toString() })
        .expect(404);

      const doc = await conn
        .collection('notifications')
        .findOne({ _id: new Types.ObjectId(deAna) });
      expect(doc?.readAt).toBeUndefined();
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

      await conToken(http().post('/internal/notifications/read-all'))
        .send({ userId: ana.toString() })
        .expect(200, { updated: 2 });
      await conToken(http().post('/internal/notifications/read-all'))
        .send({ userId: ana.toString() })
        .expect(200, { updated: 0 });

      await conToken(http().get('/internal/notifications/unread-count'))
        .query({ userId: beto.toString() })
        .expect(200, { count: 1 });
    });
  });
});

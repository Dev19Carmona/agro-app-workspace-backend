// E2E del puente `notification-bridge` contra MongoDB y RabbitMQ reales: aprobar a un
// PROVEEDOR deja un `provider.approved` sin email en RabbitMQ y un `notification_outbox`
// PUBLISHED; con el broker caído el evento espera PENDING sin gastar intentos.
//
// - Necesita MONGODB_URI y RABBITMQ_URI (entorno o `.env`): `docker compose up -d --wait`.
// - Una cola exclusiva de prueba se enlaza al exchange para leer lo publicado.
// - Los mensajes también llegan a la cola real `notifications.events`; al terminar se
//   vacía para no dejar avisos de usuarios de prueba (no la corras con datos que importen).
// - Las claves JWT las genera la suite. Crea usuarios `e2e-*-<RUN>@test.co` y los borra.
// - La caída del broker se simula cerrando la conexión del publicador (`close()`); la
//   reconexión tras una caída real la cubren los specs unitarios de `RabbitMqConnection`.
import { generateKeyPairSync, randomUUID } from 'node:crypto';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { getConnectionToken } from '@nestjs/mongoose';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { Test } from '@nestjs/testing';
import { type Connection, Types } from 'mongoose';
import request from 'supertest';
import { buildAdminDocument } from '../../../scripts/seed-admin.ts';
import { RabbitMqConnection } from '../../../libs/common/src/messaging/rabbitmq-connection.js';
import {
  EVENTS_EXCHANGE,
  NOTIFICATIONS_QUEUE,
} from '../../../libs/common/src/messaging/topology.js';

const PASSWORD = 'Segura12345';
const RUN = randomUUID().slice(0, 8);
const email = (name: string) => `e2e-${name}-${RUN}@test.co`;

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

type Json = Record<string, any>;

const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

async function until<T>(
  fn: () => Promise<T | undefined | false> | T | undefined | false,
  timeoutMs = 15_000,
): Promise<T> {
  const limit = Date.now() + timeoutMs;
  for (;;) {
    const value = await fn();
    if (value) return value;
    if (Date.now() > limit) throw new Error('Tiempo de espera agotado');
    await wait(100);
  }
}

describe('notification-bridge (e2e)', () => {
  let app: NestExpressApplication;
  let conn: Connection;
  let publisherConnection: RabbitMqConnection;
  let probe: RabbitMqConnection;
  let probeQueue: string;
  let adminToken: string;
  let adminId: string;
  const userIds: string[] = [];

  let ipCounter = 0;
  const nextIp = () => `10.30.0.${++ipCounter}`;

  const call = (
    method: 'get' | 'post',
    path: string,
    opts: { body?: object; token?: string } = {},
  ) => {
    let req = request(app.getHttpServer())
      [method](path)
      .set('X-Forwarded-For', nextIp());
    if (opts.token) req = req.set('Authorization', `Bearer ${opts.token}`);
    return opts.body === undefined ? req : req.send(opts.body);
  };

  /** Registra un PROVEEDOR pendiente y lo aprueba con el ADMIN. */
  async function approveProvider(name: string): Promise<string> {
    const reg = await call('post', '/auth/register', {
      body: {
        email: email(name),
        password: PASSWORD,
        nombre: `Usuario ${name}`,
        documento: '1020304050',
        rol: 'PROVEEDOR',
        aceptaTratamientoDatos: true,
      },
    });
    expect(reg.status).toBe(201);
    const id = reg.body.id as string;
    userIds.push(id);
    const res = await call('post', `/auth/users/${id}/approve`, {
      token: adminToken,
    });
    expect(res.status).toBe(200);
    return id;
  }

  const outboxOf = (userId: string) =>
    conn.collection('notification_outbox').findOne({ correlationId: userId });

  /** Lee de la cola de prueba hasta encontrar el mensaje de este usuario. */
  const messageFor = (userId: string) =>
    until(async () => {
      const msg = await probe.getChannel().get(probeQueue, { noAck: true });
      if (!msg) return undefined;
      return msg.properties.correlationId === userId ? msg : undefined;
    });

  beforeAll(async () => {
    const { ApiModule } = await import('../src/api.module.js');
    const { applySecurity } =
      await import('../../../libs/common/src/security/apply-security.js');
    const { PasswordService } =
      await import('../src/modules/auth/services/password.service.js');

    const moduleRef = await Test.createTestingModule({
      imports: [ApiModule],
    }).compile();
    app = moduleRef.createNestApplication<NestExpressApplication>({
      rawBody: true,
    });
    app.set('trust proxy', true);
    applySecurity(app, { corsOrigins: [] });
    await app.init();

    conn = app.get<Connection>(getConnectionToken());
    publisherConnection = app.get(RabbitMqConnection, { strict: false });

    probe = new RabbitMqConnection(process.env.RABBITMQ_URI!);
    await probe.start();
    await until(() => probe.isConnected());
    const ch = probe.getChannel();
    const q = await ch.assertQueue('', { exclusive: true, autoDelete: true });
    probeQueue = q.queue;
    await ch.bindQueue(probeQueue, EVENTS_EXCHANGE, 'provider.approved');

    const hash = await app
      .get(PasswordService, { strict: false })
      .hash(PASSWORD);
    const inserted = await conn
      .collection('users')
      .insertOne(buildAdminDocument(email('admin'), hash));
    adminId = inserted.insertedId.toString();
    const login = await call('post', '/auth/login', {
      body: { email: email('admin'), password: PASSWORD },
    });
    expect(login.status).toBe(200);
    adminToken = login.body.accessToken;
  });

  afterAll(async () => {
    const users = await conn
      .collection('users')
      .find({ email: new RegExp(`^e2e-.*-${RUN}@test\\.co$`) })
      .toArray();
    const ids = users.map((u) => u._id);
    await conn
      .collection('refresh_tokens')
      .deleteMany({ userId: { $in: ids } });
    await conn.collection('users').deleteMany({ _id: { $in: ids } });
    await conn.collection('notification_outbox').deleteMany({
      correlationId: { $in: [...userIds, adminId] },
    });
    await probe.getChannel().purgeQueue(NOTIFICATIONS_QUEUE);
    await probe.close();
    await app.close();
  });

  it('aprobar a un PROVEEDOR publica provider.approved sin email y deja el outbox PUBLISHED', async () => {
    const userId = await approveProvider('prov-ok');

    const msg = await messageFor(userId);
    const body = JSON.parse(msg.content.toString('utf8')) as Json;

    expect(body).toMatchObject({
      type: 'provider.approved',
      correlationId: userId,
      payload: { userId, reviewedBy: adminId },
    });
    expect(Object.keys(body.payload).sort()).toEqual(['reviewedBy', 'userId']);
    expect(msg.content.toString('utf8')).not.toContain(email('prov-ok'));
    expect(msg.properties).toMatchObject({
      messageId: body.eventId,
      type: 'provider.approved',
      contentType: 'application/json',
      deliveryMode: 2,
    });

    const doc = await until(async () => {
      const d = await outboxOf(userId);
      return d?.status === 'PUBLISHED' ? d : undefined;
    });
    expect(doc.eventId).toBe(body.eventId);
    expect(doc.payload).toEqual({ userId, reviewedBy: adminId });
    expect(doc.publishedAt).toBeInstanceOf(Date);
    expect(JSON.stringify(doc)).not.toContain(email('prov-ok'));
  });

  it('con el broker caído el evento sigue PENDING sin gastar intentos y se publica al volver', async () => {
    await publisherConnection.close();
    expect(publisherConnection.isConnected()).toBe(false);

    const userId = await approveProvider('prov-caido');
    await until(async () => (await outboxOf(userId)) ?? undefined);
    await wait(5_000); // más de dos ciclos del job

    const pending = await outboxOf(userId);
    expect(pending).toMatchObject({ status: 'PENDING', attempts: 0 });
    expect(pending?.publishedAt).toBeUndefined();

    await publisherConnection.start();

    await messageFor(userId);
    const doc = await until(async () => {
      const d = await outboxOf(userId);
      return d?.status === 'PUBLISHED' ? d : undefined;
    });
    expect(doc.attempts).toBe(0);
  });

  it('reenviar el mismo evento en memoria crea otro eventId (no hay deduplicación por usuario)', async () => {
    // El 11000 solo deduplica el mismo eventId; aquí se comprueba que el puente no choca
    // consigo mismo cuando auth reemite el evento.
    const events = app.get(EventEmitter2);
    const userId = new Types.ObjectId().toString();
    userIds.push(userId);

    await events.emitAsync('provider.approved', {
      userId,
      email: 'otro@test.co',
      reviewedBy: adminId,
    });
    await events.emitAsync('provider.approved', {
      userId,
      email: 'otro@test.co',
      reviewedBy: adminId,
    });

    await until(
      async () =>
        (await conn
          .collection('notification_outbox')
          .countDocuments({ correlationId: userId })) === 2,
    );
    const docs = await conn
      .collection('notification_outbox')
      .find({ correlationId: userId })
      .toArray();
    expect(new Set(docs.map((d) => d.eventId)).size).toBe(2);
    expect(JSON.stringify(docs)).not.toContain('otro@test.co');
  });
});

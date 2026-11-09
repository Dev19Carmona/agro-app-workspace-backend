// E2E del flujo completo de avisos (SPEC 10): `api` y `notifications` corren en el mismo
// proceso contra MongoDB y RabbitMQ reales. Un PRODUCTOR hace checkout de dos tiendas y
// paga con el simulador; los avisos quedan en la base `mini-croper-notifications`.
//
// - Necesita MONGODB_URI (replica set) y RABBITMQ_URI: `docker compose up -d --wait`.
// - Usa la cola real `notifications.events`: no la corras con otra instancia de
//   `notifications` consumiéndola.
// - Las claves JWT y el secreto del webhook los fija la suite. Crea usuarios
//   `e2e-*-<RUN>@test.co` y datos colgados de ellos, y los borra al terminar.
// - El simulador espera de 1 a 3 s por cobro, así que las pruebas con cobro son lentas.
import { generateKeyPairSync, randomUUID } from 'node:crypto';
import { createServer } from 'node:net';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { getConnectionToken } from '@nestjs/mongoose';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { Test } from '@nestjs/testing';
import { type Connection, Types } from 'mongoose';
import request from 'supertest';
import { buildAdminDocument } from '../../../scripts/seed-admin.ts';

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

/** Un puerto libre: se reserva y se suelta. `notifications` escucha ahí para que `api` la lea. */
const freePort = () =>
  new Promise<number>((resolve, reject) => {
    const server = createServer();
    server.once('error', reject);
    server.listen(0, () => {
      const { port } = server.address() as { port: number };
      server.close(() => resolve(port));
    });
  });

const NOTIFICATIONS_PORT = await freePort();
process.env.NOTIFICATIONS_INTERNAL_URL = `http://127.0.0.1:${NOTIFICATIONS_PORT}`;

type Method = 'get' | 'post' | 'put' | 'delete';
type Json = Record<string, any>;

const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

async function until<T>(
  fn: () => Promise<T | undefined | false> | T | undefined | false,
  timeoutMs = 20_000,
): Promise<T> {
  const limit = Date.now() + timeoutMs;
  for (;;) {
    const value = await fn();
    if (value) return value;
    if (Date.now() > limit) throw new Error('Tiempo de espera agotado');
    await wait(150);
  }
}

describe('flujo de notificaciones (e2e)', () => {
  let api: NestExpressApplication;
  let notifications: NestExpressApplication;
  let conn: Connection; // base `mini-croper`
  let nconn: Connection; // base `mini-croper-notifications`
  let events: EventEmitter2;

  let adminToken: string;
  let productor: { id: string; token: string };
  let prov1: { id: string; token: string; storeId: string };
  let prov2: { id: string; token: string; storeId: string };
  let categoryId: string;
  let v1: string; // tienda 1, 10000
  let v2: string; // tienda 2, 20000

  const orderIds = new Set<string>();
  const emitted: Json[] = [];

  let ipCounter = 0;
  const nextIp = () => `10.60.0.${++ipCounter}`;

  const call = (
    method: Method,
    path: string,
    opts: {
      body?: object;
      token?: string;
      headers?: Record<string, string>;
    } = {},
  ) => {
    let req = request(api.getHttpServer())
      [method](path)
      .set('X-Forwarded-For', nextIp());
    if (opts.token) req = req.set('Authorization', `Bearer ${opts.token}`);
    for (const [k, v] of Object.entries(opts.headers ?? {}))
      req = req.set(k, v);
    return opts.body === undefined ? req : req.send(opts.body);
  };

  const oid = (id: string) => new Types.ObjectId(id);

  async function register(name: string, rol: 'PRODUCTOR' | 'PROVEEDOR') {
    const reg = await call('post', '/auth/register', {
      body: {
        email: email(name),
        password: PASSWORD,
        nombre: name,
        documento: '1020304050',
        rol,
        aceptaTratamientoDatos: true,
      },
    });
    expect(reg.status).toBe(201);
    if (rol === 'PROVEEDOR') {
      const approve = await call('post', `/auth/users/${reg.body.id}/approve`, {
        token: adminToken,
      });
      expect(approve.status).toBe(200);
    }
    const login = await call('post', '/auth/login', {
      body: { email: email(name), password: PASSWORD },
    });
    expect(login.status).toBe(200);
    return {
      id: reg.body.id as string,
      token: login.body.accessToken as string,
      refreshToken: login.body.refreshToken as string,
    };
  }

  /** Crea la tienda y renueva el token para que lleve `storeId`. */
  async function withStore(
    prov: { id: string; token: string; refreshToken: string },
    name: string,
  ) {
    const store = await call('post', '/catalog/stores', {
      token: prov.token,
      body: { nombre: `e2e-${RUN}-${name}`, nit: '900123', municipio: 'Pasto' },
    });
    expect(store.status).toBe(201);
    await until(async () => {
      const user = await conn
        .collection('users')
        .findOne({ _id: oid(prov.id) });
      return user?.storeId?.toString() === store.body.id;
    });
    const refreshed = await call('post', '/auth/refresh', {
      body: { refreshToken: prov.refreshToken },
    });
    expect(refreshed.status).toBe(200);
    return {
      id: prov.id,
      token: refreshed.body.accessToken as string,
      storeId: store.body.id as string,
    };
  }

  async function nuevaVariante(token: string, precio: number) {
    const p = await call('post', '/catalog/products', {
      token,
      body: {
        categoryId,
        nombre: `e2e-${RUN}-producto`,
        marca: 'Agro',
        fichaTecnica: { ingrediente: 'x' },
      },
    });
    expect(p.status).toBe(201);
    const v = await call('post', `/catalog/products/${p.body.id}/variants`, {
      token,
      body: { presentacion: '4 L', unidad: 'L', precio, stock: 200 },
    });
    expect(v.status).toBe(201);
    return v.body.id as string;
  }

  /** Carrito con una unidad de cada tienda, checkout y pedido en AWAITING_PAYMENT (30000). */
  async function pedidoDeDosTiendas(): Promise<Json> {
    await call('delete', '/orders/cart', { token: productor.token });
    for (const v of [v1, v2]) {
      const add = await call('put', `/orders/cart/items/${v}`, {
        token: productor.token,
        body: { cantidad: 1 },
      });
      expect(add.status).toBe(200);
    }
    const res = await call('post', '/orders/checkout', {
      token: productor.token,
      headers: { 'Idempotency-Key': `key-${randomUUID()}` },
    });
    expect(res.status).toBe(201);
    orderIds.add(res.body.id);
    await until(
      async () =>
        (await conn.collection('orders').findOne({ _id: oid(res.body.id) }))
          ?.status === 'AWAITING_PAYMENT',
    );
    return res.body;
  }

  const pay = (orderId: string, tokenPrueba: string) =>
    call('post', '/payments', {
      token: productor.token,
      headers: { 'Idempotency-Key': `pay-${randomUUID()}` },
      body: { orderId, metodo: 'CARD', token: tokenPrueba },
    });

  const avisosDe = (correlationId: string) =>
    nconn.collection('notifications').find({ correlationId }).toArray();

  /** Espera a que haya al menos `n` avisos del pedido y devuelve todos. */
  const esperarAvisos = (correlationId: string, n: number) =>
    until(async () => {
      const docs = await avisosDe(correlationId);
      return docs.length >= n ? docs : undefined;
    });

  beforeAll(async () => {
    const { ApiModule } = await import('../src/api.module.js');
    const { NotificationsModule } =
      await import('../../notifications/src/notifications.module.js');
    const { applySecurity } =
      await import('../../../libs/common/src/security/apply-security.js');
    const { PasswordService } =
      await import('../src/modules/auth/services/password.service.js');

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
    await notifications.listen(NOTIFICATIONS_PORT, '127.0.0.1');

    conn = api.get<Connection>(getConnectionToken());
    nconn = notifications.get<Connection>(getConnectionToken());
    events = api.get(EventEmitter2);
    for (const name of ['stock.reserved', 'stock.rejected', 'stock.released']) {
      events.on(name, (e: Json) => emitted.push(e));
    }

    const hash = await api
      .get(PasswordService, { strict: false })
      .hash(PASSWORD);
    await conn
      .collection('users')
      .insertOne(buildAdminDocument(email('admin'), hash));
    adminToken = (
      await call('post', '/auth/login', {
        body: { email: email('admin'), password: PASSWORD },
      })
    ).body.accessToken;

    productor = await register('productor', 'PRODUCTOR');
    prov1 = await withStore(await register('prov1', 'PROVEEDOR'), 'tienda1');
    prov2 = await withStore(await register('prov2', 'PROVEEDOR'), 'tienda2');

    const cat = await call('post', '/catalog/categories', {
      token: adminToken,
      body: { nombre: `e2e-${RUN}-semillas` },
    });
    categoryId = cat.body.id;
    v1 = await nuevaVariante(prov1.token, 10000);
    v2 = await nuevaVariante(prov2.token, 20000);
  });

  afterAll(async () => {
    const ids = [...orderIds];
    const objectIds = ids.map(oid);
    const users = await conn
      .collection('users')
      .find({ email: new RegExp(`^e2e-.*-${RUN}@test\\.co$`) })
      .toArray();
    const userIds = users.map((u) => u._id);
    const userHex = userIds.map(String);
    const payments = await conn
      .collection('payments')
      .find({ orderId: { $in: objectIds } })
      .toArray();
    const outbox = await conn
      .collection('outbox_events')
      .find({ correlationId: { $in: ids } })
      .toArray();
    const carts = await conn
      .collection('carts')
      .find({ buyerId: { $in: userIds } })
      .toArray();
    const stores = await conn
      .collection('stores')
      .find({ ownerId: { $in: userIds } })
      .toArray();
    const products = await conn
      .collection('products')
      .find({ storeId: { $in: stores.map((s) => s._id) } })
      .toArray();

    // Avisos de la base de `notifications`.
    await nconn.collection('notifications').deleteMany({
      $or: [
        { correlationId: { $in: [...ids, ...userHex] } },
        { destinatarioId: { $in: [...userIds, ...stores.map((s) => s._id)] } },
      ],
    });

    // Datos de `api`.
    await conn
      .collection('notification_outbox')
      .deleteMany({ correlationId: { $in: [...ids, ...userHex] } });
    await conn
      .collection('payment_attempts')
      .deleteMany({ paymentId: { $in: payments.map((p) => p._id) } });
    await conn
      .collection('payments')
      .deleteMany({ _id: { $in: payments.map((p) => p._id) } });
    await conn
      .collection('cart_items')
      .deleteMany({ cartId: { $in: carts.map((c) => c._id) } });
    await conn.collection('carts').deleteMany({ buyerId: { $in: userIds } });
    await conn
      .collection('order_items')
      .deleteMany({ orderId: { $in: objectIds } });
    await conn
      .collection('sub_orders')
      .deleteMany({ orderId: { $in: objectIds } });
    await conn.collection('orders').deleteMany({ _id: { $in: objectIds } });
    await conn
      .collection('outbox_events')
      .deleteMany({ correlationId: { $in: ids } });
    await conn
      .collection('processed_events')
      .deleteMany({ eventId: { $in: outbox.map((e) => e.eventId) } });
    await conn.collection('order_processed_events').deleteMany({
      eventId: {
        $in: [
          ...emitted
            .filter((e) => ids.includes(e.correlationId))
            .map((e) => e.eventId),
          ...payments.map((p) => p.eventId).filter(Boolean),
        ],
      },
    });
    await conn
      .collection('stock_reservations')
      .deleteMany({ orderId: { $in: ids } });
    await conn
      .collection('product_variants')
      .deleteMany({ productId: { $in: products.map((p) => p._id) } });
    await conn
      .collection('products')
      .deleteMany({ _id: { $in: products.map((p) => p._id) } });
    await conn
      .collection('stores')
      .deleteMany({ _id: { $in: stores.map((s) => s._id) } });
    await conn
      .collection('categories')
      .deleteMany({ nombre: new RegExp(`^e2e-${RUN}-`, 'i') });
    await conn
      .collection('refresh_tokens')
      .deleteMany({ userId: { $in: userIds } });
    await conn.collection('users').deleteMany({ _id: { $in: userIds } });

    await notifications.close();
    await api.close();
  });

  it('el registro deja el aviso de bienvenida del productor y el acuse y la aprobación del proveedor', async () => {
    const [bienvenida] = await esperarAvisos(productor.id, 1);
    expect(bienvenida).toMatchObject({
      eventType: 'user.registered',
      destinatarioTipo: 'USER',
      plantilla: 'USER_REGISTERED',
      titulo: 'Bienvenido a Mini-Croper',
    });

    const delProveedor = await esperarAvisos(prov1.id, 2);
    expect(
      delProveedor.map((d) => d.plantilla).sort((a, b) => a.localeCompare(b)),
    ).toEqual(['PROVIDER_APPROVED', 'USER_REGISTERED']);
  });

  it('un pedido de dos tiendas pagado deja aviso del pago, del pedido y uno por tienda', async () => {
    const order = await pedidoDeDosTiendas();

    const res = await pay(order.id, 'tok_test_approved');
    expect(res.status).toBe(201);
    expect(res.body.status).toBe('APPROVED');

    // payment.approved (1) + order.confirmed (1 comprador + 2 tiendas) = 4 avisos.
    const docs = await esperarAvisos(order.id, 4);
    await wait(500);
    const todos = await avisosDe(order.id);

    expect(todos).toHaveLength(4);
    expect(
      todos
        .map((d) => `${d.destinatarioTipo}:${d.plantilla}`)
        .sort((a, b) => a.localeCompare(b)),
    ).toEqual([
      'STORE:ORDER_CONFIRMED_STORE',
      'STORE:ORDER_CONFIRMED_STORE',
      'USER:ORDER_CONFIRMED_BUYER',
      'USER:PAYMENT_APPROVED',
    ]);
    expect(
      docs
        .filter((d) => d.destinatarioTipo === 'STORE')
        .map((d) => d.destinatarioId.toString())
        .sort((a, b) => a.localeCompare(b)),
    ).toEqual(
      [prov1.storeId, prov2.storeId].sort((a, b) => a.localeCompare(b)),
    );
    for (const d of docs.filter((d) => d.destinatarioTipo === 'USER')) {
      expect(d.destinatarioId.toString()).toBe(productor.id);
    }
    const pago = todos.find((d) => d.plantilla === 'PAYMENT_APPROVED')!;
    expect(pago.mensaje).toContain('$30.000');

    // Ningún aviso lleva el correo de nadie.
    expect(JSON.stringify(todos)).not.toContain(`@test.co`);
  });

  it('el productor y cada proveedor leen sus avisos del pedido por GET /notifications', async () => {
    const [orderId] = [...orderIds];
    await esperarAvisos(orderId, 4);

    const deProductor = await call('get', '/notifications', {
      token: productor.token,
    });
    expect(deProductor.status).toBe(200);
    const delPedido = deProductor.body.data.filter(
      (a: Json) => a.orderId === orderId,
    );
    expect(
      delPedido
        .map((a: Json) => a.plantilla)
        .sort((a: string, b: string) => a.localeCompare(b)),
    ).toEqual(['ORDER_CONFIRMED_BUYER', 'PAYMENT_APPROVED']);
    for (const aviso of deProductor.body.data) {
      expect(aviso.destinatarioTipo).toBe('USER');
      expect(aviso).not.toHaveProperty('eventId');
      expect(aviso).not.toHaveProperty('correlationId');
    }

    for (const prov of [prov1, prov2]) {
      const res = await call('get', '/notifications', { token: prov.token });
      expect(res.status).toBe(200);
      const deTienda = res.body.data.filter(
        (a: Json) => a.plantilla === 'ORDER_CONFIRMED_STORE',
      );
      expect(deTienda).toHaveLength(1);
      expect(deTienda[0]).toMatchObject({
        destinatarioTipo: 'STORE',
        orderId,
        readAt: null,
      });
    }

    // unread-count del productor baja a 0 tras read-all.
    const antes = await call('get', '/notifications/unread-count', {
      token: productor.token,
    });
    expect(antes.body.count).toBeGreaterThanOrEqual(3);
    const readAll = await call('post', '/notifications/read-all', {
      token: productor.token,
    });
    expect(readAll.status).toBe(200);
    expect(readAll.body.updated).toBe(antes.body.count);
    const despues = await call('get', '/notifications/unread-count', {
      token: productor.token,
    });
    expect(despues.body).toEqual({ count: 0 });
  });

  it('el puente deja los eventos del pedido en PUBLISHED, con el eventId del origen', async () => {
    const [orderId] = [...orderIds];
    const docs = await until(async () => {
      const found = await conn
        .collection('notification_outbox')
        .find({ correlationId: orderId })
        .toArray();
      return found.length >= 2 && found.every((d) => d.status === 'PUBLISHED')
        ? found
        : undefined;
    });

    expect(docs.map((d) => d.type).sort((a, b) => a.localeCompare(b))).toEqual([
      'order.confirmed',
      'payment.approved',
    ]);
    const confirmed = docs.find((d) => d.type === 'order.confirmed')!;
    const origen = await conn
      .collection('outbox_events')
      .findOne({ correlationId: orderId, type: 'order.confirmed' });
    expect(confirmed.eventId).toBe(origen?.eventId);
    expect(confirmed.payload.storeIds).toHaveLength(2);
  });

  it('un pago rechazado deja solo el aviso de rechazo y ningún pedido confirmado', async () => {
    const order = await pedidoDeDosTiendas();

    const res = await pay(order.id, 'tok_test_declined');
    expect(res.status).toBe(201);
    expect(res.body.status).toBe('DECLINED');

    const [aviso] = await esperarAvisos(order.id, 1);
    await wait(1_000);

    const todos = await avisosDe(order.id);
    expect(todos).toHaveLength(1);
    expect(aviso).toMatchObject({
      eventType: 'payment.declined',
      destinatarioTipo: 'USER',
      plantilla: 'PAYMENT_DECLINED',
    });
    expect(aviso.destinatarioId.toString()).toBe(productor.id);
    expect(
      await conn
        .collection('notification_outbox')
        .countDocuments({ correlationId: order.id, type: 'order.confirmed' }),
    ).toBe(0);
  });
});

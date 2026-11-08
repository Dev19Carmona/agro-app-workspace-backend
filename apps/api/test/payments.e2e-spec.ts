// E2E del módulo payments contra MongoDB real, con `order` y `catalog` reales:
// pago idempotente, simulador, webhook firmado, reemisión, visibilidad por rol y
// límite de peticiones.
//
// - Necesita MONGODB_URI (entorno o `.env`) y un MongoDB en replica set
//   (`docker compose up -d --wait`): el pago y el webhook usan transacciones.
// - Las claves JWT y el secreto del webhook los fija la propia suite.
// - `api` usa la base fija `mini-croper`. La suite crea usuarios `e2e-*-<RUN>@test.co`
//   y datos colgados de ellos, y los borra al terminar (si se corta, pueden quedar).
// - El simulador espera de 1 a 3 s por cobro, así que las pruebas con cobro son lentas.
// - Cada petición usa su propia IP (`X-Forwarded-For` con `trust proxy` solo en la
//   suite) para no chocar con el throttler; la prueba del límite fija una IP.
import { generateKeyPairSync, randomUUID } from 'node:crypto';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { getConnectionToken } from '@nestjs/mongoose';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { Test } from '@nestjs/testing';
import { type Connection, Types } from 'mongoose';
import request from 'supertest';
import { buildAdminDocument } from '../../../scripts/seed-admin.ts';
import { OrderExpirationService } from '../src/modules/order/services/order-expiration.service.js';
import { computeWebhookSignature } from '../src/modules/payments/policies/webhook-signature.policy.js';
import { PaymentEventsService } from '../src/modules/payments/services/payment-events.service.js';

const PASSWORD = 'Segura12345';
const RUN = randomUUID().slice(0, 8);
const email = (name: string) => `e2e-${name}-${RUN}@test.co`;
const ZERO_ID = '000000000000000000000000';
const WEBHOOK_SECRET = 'e2e-webhook-secret-0123456789abcdef';

// Deben fijarse antes de importar `ApiModule` (el entorno se valida al evaluarlo).
const keys = generateKeyPairSync('rsa', {
  modulusLength: 2048,
  privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
  publicKeyEncoding: { type: 'spki', format: 'pem' },
});
process.env.JWT_PRIVATE_KEY = keys.privateKey;
process.env.JWT_PUBLIC_KEY = keys.publicKey;
process.env.PAYMENTS_WEBHOOK_SECRET = WEBHOOK_SECRET;
process.env.CORS_ORIGINS = '';

type Method = 'get' | 'post' | 'put' | 'patch' | 'delete';
type Opts = { body?: object; token?: string; headers?: Record<string, string> };
type Json = Record<string, any>;

describe('payments (e2e)', () => {
  let app: NestExpressApplication;
  let conn: Connection;
  let events: EventEmitter2;
  let expiration: OrderExpirationService;
  let paymentEvents: PaymentEventsService;

  let adminToken: string;
  let productor: { id: string; token: string };
  let productor2: { id: string; token: string };
  let prov1: { id: string; token: string; storeId: string };
  let categoryId: string;
  let v1: string; // tienda 1, 10000, stock 200

  const orderIds = new Set<string>();
  /** Eventos `stock.*` emitidos durante la suite (idempotencia de `order`). */
  const emitted: Json[] = [];
  /** `eventId` de los webhooks enviados (`payment_processed_events`). */
  const webhookEventIds = new Set<string>();

  let ipCounter = 0;
  const nextIp = () =>
    `10.50.${Math.floor(++ipCounter / 250)}.${(ipCounter % 250) + 1}`;

  const call = (method: Method, path: string, opts: Opts = {}) => {
    let req = request(app.getHttpServer())
      [method](path)
      .set('X-Forwarded-For', nextIp());
    if (opts.token) req = req.set('Authorization', `Bearer ${opts.token}`);
    for (const [k, v] of Object.entries(opts.headers ?? {}))
      req = req.set(k, v);
    return opts.body === undefined ? req : req.send(opts.body);
  };

  /** Reintenta hasta que `fn` deja de lanzar (jobs y listeners son asíncronos). */
  async function waitFor<T>(fn: () => Promise<T>, ms = 15_000): Promise<T> {
    const limit = Date.now() + ms;
    let last: unknown;
    while (Date.now() < limit) {
      try {
        return await fn();
      } catch (e) {
        last = e;
        await new Promise((r) => setTimeout(r, 200));
      }
    }
    throw last;
  }

  const oid = (id: string) => new Types.ObjectId(id);
  const orderDoc = (id: string) =>
    conn.collection('orders').findOne({ _id: oid(id) });
  const paymentDoc = (id: string) =>
    conn.collection('payments').findOne({ _id: oid(id) });
  const paymentsOfOrder = (orderId: string) =>
    conn
      .collection('payments')
      .find({ orderId: oid(orderId) })
      .toArray();
  const attemptsOf = (paymentId: string) =>
    conn
      .collection('payment_attempts')
      .find({ paymentId: oid(paymentId) })
      .sort({ createdAt: 1 })
      .toArray();
  const waitStatus = (orderId: string, status: string) =>
    waitFor(async () => {
      const doc = await orderDoc(orderId);
      expect(doc?.status).toBe(status);
      return doc!;
    });
  const waitEmitted = (paymentId: string) =>
    waitFor(async () => {
      const doc = await paymentDoc(paymentId);
      expect(doc?.eventEmittedAt).toBeInstanceOf(Date);
      return doc!;
    });

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
    await waitFor(async () => {
      const user = await conn
        .collection('users')
        .findOne({ _id: oid(prov.id) });
      expect(user?.storeId?.toString()).toBe(store.body.id);
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

  async function nuevaVariante(token: string, variante: Json = {}) {
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
      body: {
        presentacion: '4 L',
        unidad: 'L',
        precio: 10000,
        stock: 10,
        ...variante,
      },
    });
    expect(v.status).toBe(201);
    return v.body.id as string;
  }

  /** Carrito de 1 unidad de `v1`, checkout y pedido en AWAITING_PAYMENT (total 10000). */
  async function pedido(buyer = productor): Promise<Json> {
    await call('delete', '/orders/cart', { token: buyer.token });
    const add = await call('put', `/orders/cart/items/${v1}`, {
      token: buyer.token,
      body: { cantidad: 1 },
    });
    expect(add.status).toBe(200);
    const res = await call('post', '/orders/checkout', {
      token: buyer.token,
      headers: { 'Idempotency-Key': `key-${randomUUID()}` },
    });
    expect(res.status).toBe(201);
    orderIds.add(res.body.id);
    await waitStatus(res.body.id, 'AWAITING_PAYMENT');
    return res.body;
  }

  const pay = (
    orderId: string,
    tokenPrueba = 'tok_test_approved',
    opts: { key?: string; token?: string; metodo?: string } = {},
  ) =>
    call('post', '/payments', {
      token: opts.token ?? productor.token,
      headers: { 'Idempotency-Key': opts.key ?? `pay-${randomUUID()}` },
      body: { orderId, metodo: opts.metodo ?? 'CARD', token: tokenPrueba },
    });

  /** Webhook firmado; `ts`/`sig` en `null` omiten el header. */
  const webhook = (
    payload: Json,
    opts: { ts?: string | null; sig?: string | null; raw?: string } = {},
  ) => {
    const raw = opts.raw ?? JSON.stringify(payload);
    const ts =
      opts.ts === undefined ? String(Math.floor(Date.now() / 1000)) : opts.ts;
    const sig =
      opts.sig === undefined
        ? computeWebhookSignature(WEBHOOK_SECRET, ts ?? '', raw)
        : opts.sig;
    let req = request(app.getHttpServer())
      .post('/payments/webhook')
      .set('X-Forwarded-For', nextIp())
      .set('Content-Type', 'application/json');
    if (ts !== null) req = req.set('X-Timestamp', ts);
    if (sig !== null) req = req.set('X-Signature', sig);
    return req.send(raw);
  };
  const resolvePayment = (
    paymentId: string,
    resultado: 'APPROVED' | 'DECLINED' | 'ERROR',
    extra: Json = {},
  ) => {
    const eventId = randomUUID();
    webhookEventIds.add(eventId);
    return { eventId, send: () => webhook({ eventId, paymentId, resultado, ...extra }) };
  };

  /** Pedido con un pago `PROCESSING` (tok_test_pending). */
  async function pedidoConPagoEnProceso() {
    const order = await pedido();
    const res = await pay(order.id, 'tok_test_pending');
    expect(res.status).toBe(201);
    expect(res.body.status).toBe('PROCESSING');
    return { order, payment: res.body as Json };
  }

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
    events = app.get(EventEmitter2);
    expiration = app.get(OrderExpirationService);
    paymentEvents = app.get(PaymentEventsService);
    for (const name of ['stock.reserved', 'stock.rejected', 'stock.released']) {
      events.on(name, (e: Json) => emitted.push(e));
    }

    const hash = await app
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
    productor2 = await register('productor2', 'PRODUCTOR');
    const p1 = await register('prov1', 'PROVEEDOR');
    prov1 = await withStore(p1, 'tienda1');

    const cat = await call('post', '/catalog/categories', {
      token: adminToken,
      body: { nombre: `e2e-${RUN}-semillas` },
    });
    categoryId = cat.body.id;
    v1 = await nuevaVariante(prov1.token, { precio: 10000, stock: 200 });
  });

  afterAll(async () => {
    const ids = [...orderIds];
    const objectIds = ids.map(oid);
    const outbox = await conn
      .collection('outbox_events')
      .find({ correlationId: { $in: ids } })
      .toArray();
    const users = await conn
      .collection('users')
      .find({ email: new RegExp(`^e2e-.*-${RUN}@test\\.co$`) })
      .toArray();
    const userIds = users.map((u) => u._id);
    const payments = await conn
      .collection('payments')
      .find({ orderId: { $in: objectIds } })
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

    await conn
      .collection('payment_attempts')
      .deleteMany({ paymentId: { $in: payments.map((p) => p._id) } });
    await conn
      .collection('payments')
      .deleteMany({ _id: { $in: payments.map((p) => p._id) } });
    await conn
      .collection('payment_processed_events')
      .deleteMany({ eventId: { $in: [...webhookEventIds] } });
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
    // Idempotencia de `order`: eventos `stock.*` y `payment.*` de los pagos.
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
    await app.close();
  });

  describe('acceso por token y por rol', () => {
    it.each([
      ['post', '/payments'],
      ['get', '/payments'],
      ['get', `/payments/${ZERO_ID}`],
      ['get', '/payments/admin'],
      ['get', `/payments/admin/${ZERO_ID}`],
    ] as [Method, string][])('%s %s sin token da 401', async (m, ruta) => {
      expect((await call(m, ruta)).status).toBe(401);
    });

    it('el webhook no pide JWT: sin firma responde 401 por la firma, no por el token', async () => {
      const res = await webhook({ eventId: randomUUID() }, { sig: null });
      expect(res.status).toBe(401);
      expect(res.body.message).toBe('Firma inválida');
    });

    it('PROVEEDOR y ADMIN reciben 403 en POST /payments', async () => {
      for (const token of [prov1.token, adminToken]) {
        const res = await pay(ZERO_ID, 'tok_test_approved', { token });
        expect(res.status).toBe(403);
      }
    });

    it('PRODUCTOR y PROVEEDOR reciben 403 en /payments/admin*', async () => {
      for (const token of [productor.token, prov1.token]) {
        for (const ruta of ['/payments/admin', `/payments/admin/${ZERO_ID}`]) {
          expect((await call('get', ruta, { token })).status).toBe(403);
        }
      }
    });

    it('PROVEEDOR recibe 403 en GET /payments y GET /payments/:id', async () => {
      for (const ruta of ['/payments', `/payments/${ZERO_ID}`]) {
        expect(
          (await call('get', ruta, { token: prov1.token })).status,
        ).toBe(403);
      }
    });
  });

  describe('validación de POST /payments', () => {
    const body = { orderId: ZERO_ID, metodo: 'CARD', token: 'tok_test_approved' };
    const key = { 'Idempotency-Key': 'clave-de-prueba-1' };

    it('sin Idempotency-Key devuelve 400', async () => {
      const res = await call('post', '/payments', {
        token: productor.token,
        body,
      });
      expect(res.status).toBe(400);
    });

    it.each([
      ['una propiedad de más', { ...body, extra: 1 }],
      ['un monto del cliente', { ...body, monto: 1 }],
      ['un metodo desconocido', { ...body, metodo: 'EFECTIVO' }],
      ['{"$ne": null} como orderId', { ...body, orderId: { $ne: null } }],
      ['{"$ne": null} como cuerpo', { $ne: null }],
    ])('%s devuelve 400', async (_n, cuerpo) => {
      const res = await call('post', '/payments', {
        token: productor.token,
        headers: key,
        body: cuerpo,
      });
      expect(res.status).toBe(400);
    });

    it('un pedido inexistente devuelve 404', async () => {
      const res = await call('post', '/payments', {
        token: productor.token,
        headers: key,
        body,
      });
      expect(res.status).toBe(404);
    });

    it('un pedido de otro comprador devuelve 404 y no crea pago', async () => {
      const order = await pedido(productor);

      const res = await pay(order.id, 'tok_test_approved', {
        token: productor2.token,
      });

      expect(res.status).toBe(404);
      expect(await paymentsOfOrder(order.id)).toHaveLength(0);
    });
  });

  describe('pedido no pagable', () => {
    it('PENDING, CONFIRMED, CANCELLED y AWAITING_PAYMENT vencido devuelven 409 ORDER_NOT_PAYABLE', async () => {
      const order = await pedido();
      const set = (fields: Json) =>
        conn
          .collection('orders')
          .updateOne({ _id: oid(order.id) }, { $set: fields });

      for (const status of ['PENDING', 'CONFIRMED', 'CANCELLED']) {
        await set({ status });
        const res = await pay(order.id);
        expect(res.status).toBe(409);
        expect(res.body.code).toBe('ORDER_NOT_PAYABLE');
      }

      await set({
        status: 'AWAITING_PAYMENT',
        expiresAt: new Date(Date.now() - 1000),
      });
      const vencido = await pay(order.id);
      expect(vencido.status).toBe(409);
      expect(vencido.body.code).toBe('ORDER_NOT_PAYABLE');
      expect(await paymentsOfOrder(order.id)).toHaveLength(0);
    });
  });

  describe('pago aprobado e idempotencia', () => {
    let order: Json;
    let key: string;
    let payment: Json;

    it('tok_test_approved cobra el monto del pedido, queda APPROVED y confirma el pedido', async () => {
      order = await pedido();
      key = `pay-${randomUUID()}`;

      const res = await pay(order.id, 'tok_test_approved', { key });

      expect(res.status).toBe(201);
      payment = res.body;
      expect(payment).toMatchObject({
        orderId: order.id,
        monto: order.total,
        moneda: 'COP',
        metodo: 'CARD',
        status: 'APPROVED',
      });
      expect(payment.referencia).toMatch(/^SIM-[0-9a-f-]{36}$/);
      await waitStatus(order.id, 'CONFIRMED');
      const doc = await waitEmitted(payment.id);
      expect(doc.eventId).toMatch(/^[0-9a-f-]{36}$/);
      expect(doc.monto).toBe(order.total);
    });

    it('el cobro tarda entre 1 y 3 s', async () => {
      const otro = await pedido();
      const t0 = Date.now();

      const res = await pay(otro.id);

      const ms = Date.now() - t0;
      expect(res.status).toBe(201);
      expect(ms).toBeGreaterThanOrEqual(950);
      expect(ms).toBeLessThan(5000);
    });

    it('la respuesta no incluye idempotencyKey, requestHash, eventId ni token', () => {
      const texto = JSON.stringify(payment);
      for (const prohibido of [
        'idempotencyKey',
        'requestHash',
        'eventId',
        'tok_test',
        key,
      ]) {
        expect(texto).not.toContain(prohibido);
      }
    });

    it('guarda el hash y nunca el token, y deja un PaymentAttempt sin token', async () => {
      const doc = await paymentDoc(payment.id);
      expect(doc?.requestHash).toMatch(/^[0-9a-f]{64}$/);
      const intentos = await attemptsOf(payment.id);
      expect(intentos).toHaveLength(1);
      expect(intentos[0]).toMatchObject({
        origen: 'SIMULATOR',
        resultado: 'APPROVED',
      });
      expect(JSON.stringify([doc, intentos])).not.toContain('tok_test');
    });

    it('repetir la Idempotency-Key devuelve 200 con el mismo pago y no crea nada más', async () => {
      const res = await pay(order.id, 'tok_test_approved', { key });

      expect(res.status).toBe(200);
      expect(res.body.id).toBe(payment.id);
      expect(await paymentsOfOrder(order.id)).toHaveLength(1);
      expect(await attemptsOf(payment.id)).toHaveLength(1);
    });

    it.each([
      ['otro token', { tokenPrueba: 'tok_test_declined' }],
      ['otro metodo', { metodo: 'PSE' }],
    ])('repetir la clave con %s devuelve 422', async (_n, cambio) => {
      const res = await pay(order.id, cambio.tokenPrueba ?? 'tok_test_approved', {
        key,
        metodo: cambio.metodo,
      });
      expect(res.status).toBe(422);
    });

    it('repetir la clave con otro orderId devuelve 422', async () => {
      const otro = await pedido();
      const res = await pay(otro.id, 'tok_test_approved', { key });
      expect(res.status).toBe(422);
      expect(await paymentsOfOrder(otro.id)).toHaveLength(0);
    });

    it('un pedido ya pagado no admite otro pago', async () => {
      const res = await pay(order.id);
      expect(res.status).toBe(409);
      expect(res.body.code).toBe('ORDER_NOT_PAYABLE');
    });

    it('dos peticiones simultáneas con la misma clave dejan un solo Payment', async () => {
      const otro = await pedido();
      const k = `pay-${randomUUID()}`;

      const [a, b] = await Promise.all([
        pay(otro.id, 'tok_test_approved', { key: k }),
        pay(otro.id, 'tok_test_approved', { key: k }),
      ]);

      expect([a.status, b.status].sort((x, y) => x - y)).toEqual([200, 201]);
      expect(a.body.id).toBe(b.body.id);
      expect(await paymentsOfOrder(otro.id)).toHaveLength(1);
      expect(await attemptsOf(a.body.id)).toHaveLength(1);
    });

    it('el índice único parcial sobre orderId existe en la base', async () => {
      const indices = await conn.collection('payments').indexes();
      const parcial = indices.find(
        (i) => i.key?.orderId === 1 && i.partialFilterExpression,
      );
      expect(parcial?.unique).toBe(true);
      expect(parcial?.partialFilterExpression).toEqual({
        status: { $in: ['PENDING', 'PROCESSING', 'APPROVED'] },
      });
    });

    it('la base impide dos pagos APPROVED del mismo pedido', async () => {
      const doc = await paymentDoc(payment.id);
      const { _id, ...resto } = doc!;
      await expect(
        conn.collection('payments').insertOne({
          ...resto,
          idempotencyKey: `dup-${randomUUID()}`,
        }),
      ).rejects.toMatchObject({ code: 11000 });
    });
  });

  describe('resultados del simulador y reintento', () => {
    let order: Json;

    it('tok_test_declined deja DECLINED con INSUFFICIENT_FUNDS y el pedido sigue AWAITING_PAYMENT', async () => {
      order = await pedido();

      const res = await pay(order.id, 'tok_test_declined');

      expect(res.status).toBe(201);
      expect(res.body).toMatchObject({
        status: 'DECLINED',
        motivoRechazo: 'INSUFFICIENT_FUNDS',
      });
      await waitEmitted(res.body.id);
      expect((await orderDoc(order.id))?.status).toBe('AWAITING_PAYMENT');
    });

    it('tok_test_error deja ERROR con GATEWAY_ERROR', async () => {
      const res = await pay(order.id, 'tok_test_error');

      expect(res.status).toBe(201);
      expect(res.body).toMatchObject({
        status: 'ERROR',
        motivoRechazo: 'GATEWAY_ERROR',
      });
      await waitEmitted(res.body.id);
    });

    it('cualquier otro token deja DECLINED con INVALID_TOKEN', async () => {
      const res = await pay(order.id, 'tok_cualquiera');

      expect(res.status).toBe(201);
      expect(res.body).toMatchObject({
        status: 'DECLINED',
        motivoRechazo: 'INVALID_TOKEN',
      });
      await waitEmitted(res.body.id);
    });

    it('tras DECLINED y ERROR, otra clave sobre el mismo pedido crea un pago nuevo que se aprueba', async () => {
      const res = await pay(order.id, 'tok_test_approved');

      expect(res.status).toBe(201);
      expect(res.body.status).toBe('APPROVED');
      await waitStatus(order.id, 'CONFIRMED');
      expect(await paymentsOfOrder(order.id)).toHaveLength(4);
    });

    it('cada intento deja un PaymentAttempt y ninguno contiene el token', async () => {
      const pagos = await paymentsOfOrder(order.id);
      const intentos = (
        await Promise.all(pagos.map((p) => attemptsOf(p._id.toString())))
      ).flat();

      expect(intentos).toHaveLength(4);
      expect(
        intentos.map((i) => i.resultado as string).sort((x, y) => x.localeCompare(y)),
      ).toEqual([
        'APPROVED',
        'DECLINED',
        'DECLINED',
        'ERROR',
      ]);
      expect(JSON.stringify(intentos)).not.toContain('tok_');
    });
  });

  describe('webhook', () => {
    it('tok_test_pending deja PROCESSING sin evento y bloquea otro pago del pedido (409 PAYMENT_IN_PROGRESS)', async () => {
      const { order, payment } = await pedidoConPagoEnProceso();

      const doc = await paymentDoc(payment.id);
      expect(doc?.status).toBe('PROCESSING');
      expect(doc?.eventId).toBeUndefined();
      expect(doc?.eventEmittedAt).toBeUndefined();
      expect((await attemptsOf(payment.id))[0]).toMatchObject({
        origen: 'SIMULATOR',
        resultado: 'PROCESSING',
      });

      const otro = await pay(order.id);
      expect(otro.status).toBe(409);
      expect(otro.body.code).toBe('PAYMENT_IN_PROGRESS');
    });

    it('una firma válida resuelve el pago a APPROVED, confirma el pedido y emite el evento', async () => {
      const { order, payment } = await pedidoConPagoEnProceso();
      const ev = resolvePayment(payment.id, 'APPROVED');

      const res = await ev.send();

      expect(res.status).toBe(200);
      expect(res.body).toEqual({ status: 'OK' });
      expect((await paymentDoc(payment.id))?.status).toBe('APPROVED');
      await waitEmitted(payment.id);
      await waitStatus(order.id, 'CONFIRMED');
      const intentos = await attemptsOf(payment.id);
      expect(intentos.map((i) => i.origen)).toEqual(['SIMULATOR', 'WEBHOOK']);
    });

    it('el mismo eventId repetido devuelve 200 y no cambia nada ni emite otro evento', async () => {
      const { payment } = await pedidoConPagoEnProceso();
      const ev = resolvePayment(payment.id, 'DECLINED', { motivo: 'FRAUDE' });
      expect((await ev.send()).status).toBe(200);
      const antes = await paymentDoc(payment.id);
      const intentosAntes = (await attemptsOf(payment.id)).length;

      const repetido = await ev.send();

      expect(repetido.status).toBe(200);
      expect(await paymentDoc(payment.id)).toEqual(antes);
      expect(await attemptsOf(payment.id)).toHaveLength(intentosAntes);
    });

    it('un pago ya resuelto responde 200 sin cambios (con otro eventId)', async () => {
      const { payment } = await pedidoConPagoEnProceso();
      expect((await resolvePayment(payment.id, 'DECLINED').send()).status).toBe(
        200,
      );
      const antes = await paymentDoc(payment.id);
      const intentosAntes = (await attemptsOf(payment.id)).length;

      const res = await resolvePayment(payment.id, 'APPROVED').send();

      expect(res.status).toBe(200);
      expect(await paymentDoc(payment.id)).toEqual(antes);
      expect((await paymentDoc(payment.id))?.status).toBe('DECLINED');
      expect(await attemptsOf(payment.id)).toHaveLength(intentosAntes);
    });

    it('ERROR puede llegar por webhook y emite payment.declined', async () => {
      const { order, payment } = await pedidoConPagoEnProceso();

      const res = await resolvePayment(payment.id, 'ERROR', {
        motivo: 'TIMEOUT',
      }).send();

      expect(res.status).toBe(200);
      expect(await paymentDoc(payment.id)).toMatchObject({
        status: 'ERROR',
        motivoRechazo: 'TIMEOUT',
      });
      await waitEmitted(payment.id);
      expect((await orderDoc(order.id))?.status).toBe('AWAITING_PAYMENT');
    });

    it('firma alterada, ausente, timestamp ausente o a más de 300 s devuelven 401 y no modifican nada', async () => {
      const { payment } = await pedidoConPagoEnProceso();
      const antes = await paymentDoc(payment.id);
      const payload = {
        eventId: randomUUID(),
        paymentId: payment.id,
        resultado: 'APPROVED',
      };
      webhookEventIds.add(payload.eventId);
      const viejo = String(Math.floor(Date.now() / 1000) - 301);
      const raw = JSON.stringify(payload);

      const respuestas = await Promise.all([
        webhook(payload, { sig: 'a'.repeat(64) }),
        webhook(payload, { sig: null }),
        webhook(payload, { ts: null, sig: 'a'.repeat(64) }),
        webhook(payload, {
          ts: viejo,
          sig: computeWebhookSignature(WEBHOOK_SECRET, viejo, raw),
        }),
        webhook(payload, { raw: raw + ' ' , sig: computeWebhookSignature(WEBHOOK_SECRET, String(Math.floor(Date.now() / 1000)), raw) }),
      ]);

      for (const res of respuestas) {
        expect(res.status).toBe(401);
        expect(res.body.message).toBe('Firma inválida');
      }
      expect(await paymentDoc(payment.id)).toEqual(antes);
      expect(
        await conn
          .collection('payment_processed_events')
          .countDocuments({ eventId: payload.eventId }),
      ).toBe(0);
    });

    it('con firma válida, un cuerpo inválido devuelve 400 y un pago inexistente 404', async () => {
      const invalido = await webhook({ eventId: 'x', paymentId: ZERO_ID });
      expect(invalido.status).toBe(400);

      const extra = await webhook({
        eventId: randomUUID(),
        paymentId: ZERO_ID,
        resultado: 'APPROVED',
        monto: 1,
      });
      expect(extra.status).toBe(400);

      const inexistente = resolvePayment(ZERO_ID, 'APPROVED');
      expect((await inexistente.send()).status).toBe(404);
      // El 404 aborta la transacción: el eventId no queda consumido.
      expect(
        await conn
          .collection('payment_processed_events')
          .countDocuments({ eventId: inexistente.eventId }),
      ).toBe(0);
    });

    it('pago tardío: con el pedido ya cancelado el pago queda APPROVED, emite el evento y el pedido sigue CANCELLED', async () => {
      const { order, payment } = await pedidoConPagoEnProceso();
      await conn
        .collection('orders')
        .updateOne(
          { _id: oid(order.id) },
          { $set: { expiresAt: new Date(Date.now() - 1000) } },
        );
      await expiration.expireOrders();
      expect((await orderDoc(order.id))?.status).toBe('CANCELLED');

      const res = await resolvePayment(payment.id, 'APPROVED').send();

      expect(res.status).toBe(200);
      expect((await paymentDoc(payment.id))?.status).toBe('APPROVED');
      await waitEmitted(payment.id);
      expect((await orderDoc(order.id))?.status).toBe('CANCELLED');
    });
  });

  describe('reemisión de eventos', () => {
    it('reemite con el mismo eventId un pago final sin marca, y order no repite la transición', async () => {
      const order = await pedido();
      const res = await pay(order.id);
      expect(res.status).toBe(201);
      await waitStatus(order.id, 'CONFIRMED');
      const antes = await waitEmitted(res.body.id);
      const confirmados = await conn
        .collection('outbox_events')
        .countDocuments({ correlationId: order.id, type: 'order.confirmed' });
      // Simula una caída entre el commit y la marca de emisión.
      await conn.collection('payments').updateOne(
        { _id: oid(res.body.id) },
        {
          $unset: { eventEmittedAt: '' },
          $set: { finalizedAt: new Date(Date.now() - 60_000) },
        },
      );

      await paymentEvents.reemit();

      const despues = await paymentDoc(res.body.id);
      expect(despues?.eventEmittedAt).toBeInstanceOf(Date);
      expect(despues?.eventAttempts).toBe(1);
      expect(despues?.eventId).toBe(antes.eventId);
      expect(
        await conn
          .collection('outbox_events')
          .countDocuments({ correlationId: order.id, type: 'order.confirmed' }),
      ).toBe(confirmados);
    });

    it('con 5 intentos agotados ya no reintenta', async () => {
      const order = await pedido();
      const res = await pay(order.id, 'tok_test_declined');
      await waitEmitted(res.body.id);
      await conn.collection('payments').updateOne(
        { _id: oid(res.body.id) },
        {
          $unset: { eventEmittedAt: '' },
          $set: { finalizedAt: new Date(Date.now() - 60_000), eventAttempts: 5 },
        },
      );

      await paymentEvents.reemit();

      const doc = await paymentDoc(res.body.id);
      expect(doc?.eventEmittedAt).toBeUndefined();
      expect(doc?.eventAttempts).toBe(5);
    });
  });

  describe('visibilidad por rol', () => {
    let propio: Json;

    beforeAll(async () => {
      const order = await pedido(productor2);
      const res = await pay(order.id, 'tok_test_approved', {
        token: productor2.token,
      });
      expect(res.status).toBe(201);
      propio = res.body;
    });

    it('GET /payments devuelve solo los pagos del PRODUCTOR, con limit 20 por defecto; limit=101 da 400', async () => {
      const res = await call('get', '/payments', { token: productor2.token });

      expect(res.status).toBe(200);
      expect(res.body.limit).toBe(20);
      expect(res.body.data.map((p: Json) => p.id)).toEqual([propio.id]);
      expect(JSON.stringify(res.body)).not.toContain('idempotencyKey');
      expect(JSON.stringify(res.body)).not.toContain('requestHash');
      expect(
        (await call('get', '/payments?limit=101', { token: productor2.token }))
          .status,
      ).toBe(400);

      const delOtro = await call('get', '/payments?limit=100', {
        token: productor.token,
      });
      expect(delOtro.body.data.map((p: Json) => p.id)).not.toContain(propio.id);
    });

    it('GET /payments filtra por status y orderId', async () => {
      const ok = await call(
        'get',
        `/payments?status=APPROVED&orderId=${propio.orderId}`,
        { token: productor2.token },
      );
      expect(ok.body.total).toBe(1);

      const ninguno = await call('get', '/payments?status=DECLINED', {
        token: productor2.token,
      });
      expect(ninguno.body.total).toBe(0);
    });

    it('GET /payments/:id de un pago propio devuelve 200 y de uno ajeno 404', async () => {
      const mio = await call('get', `/payments/${propio.id}`, {
        token: productor2.token,
      });
      expect(mio.status).toBe(200);
      expect(mio.body.id).toBe(propio.id);

      const ajeno = await call('get', `/payments/${propio.id}`, {
        token: productor.token,
      });
      expect(ajeno.status).toBe(404);
    });

    it('ADMIN lista todos con filtros status, buyerId y orderId', async () => {
      const todos = await call('get', '/payments/admin?limit=100', {
        token: adminToken,
      });
      expect(todos.status).toBe(200);
      expect(todos.body.total).toBeGreaterThan(1);

      const filtrado = await call(
        'get',
        `/payments/admin?status=APPROVED&buyerId=${productor2.id}&orderId=${propio.orderId}`,
        { token: adminToken },
      );
      expect(filtrado.body.data).toHaveLength(1);
      expect(filtrado.body.data[0]).toMatchObject({
        id: propio.id,
        buyerId: productor2.id,
      });
      expect(
        (await call('get', '/payments/admin?limit=101', { token: adminToken }))
          .status,
      ).toBe(400);
    });

    it('ADMIN ve el detalle con sus intentos y sin campos sensibles', async () => {
      const res = await call('get', `/payments/admin/${propio.id}`, {
        token: adminToken,
      });

      expect(res.status).toBe(200);
      expect(res.body.attempts).toEqual([
        expect.objectContaining({ origen: 'SIMULATOR', resultado: 'APPROVED' }),
      ]);
      const texto = JSON.stringify(res.body);
      for (const prohibido of ['idempotencyKey', 'requestHash', 'eventId', 'tok_']) {
        expect(texto).not.toContain(prohibido);
      }
      expect(
        (await call('get', `/payments/admin/${ZERO_ID}`, { token: adminToken }))
          .status,
      ).toBe(404);
    });

    it('ADMIN no puede modificar pagos', async () => {
      for (const m of ['post', 'put', 'patch', 'delete'] as const) {
        const res = await call(m, `/payments/admin/${propio.id}`, {
          token: adminToken,
        });
        expect(res.status).toBe(404);
      }
      expect((await paymentDoc(propio.id))?.status).toBe('APPROVED');
    });
  });

  describe('límite de peticiones', () => {
    it('la petición 11 del mismo minuto desde la misma IP devuelve 429', async () => {
      const ip = '10.99.0.1';
      const get = () =>
        request(app.getHttpServer())
          .get('/payments')
          .set('X-Forwarded-For', ip)
          .set('Authorization', `Bearer ${productor.token}`);

      const estados: number[] = [];
      for (let i = 0; i < 11; i++) estados.push((await get()).status);

      expect(estados.slice(0, 10)).toEqual(Array(10).fill(200));
      expect(estados[10]).toBe(429);
    });
  });
});

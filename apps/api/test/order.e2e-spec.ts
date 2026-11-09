// E2E del módulo order contra MongoDB real: carrito, checkout, saga con `catalog`
// real, outbox, expiración y visibilidad por rol.
//
// - Necesita MONGODB_URI (entorno o `.env`) y un MongoDB en replica set
//   (`docker compose up -d --wait`): checkout, saga y expiración usan transacciones.
// - Las claves JWT las genera la propia suite.
// - `api` usa la base fija `mini-croper`. La suite crea usuarios `e2e-*-<RUN>@test.co`
//   y datos colgados de ellos, y los borra al terminar (si se corta, pueden quedar).
// - Los jobs de verdad (outbox cada 2 s) corren en la app. La expiración (cada 10 s)
//   se acelera llamando a `OrderExpirationService.expireOrders()` tras mover las
//   fechas en Mongo; `payment.approved` lo emite la suite con `EventEmitter2`
//   porque `payments` aún no existe.
// - Cada petición usa su propia IP (`X-Forwarded-For` con `trust proxy` solo en la
//   suite) para no chocar con el throttler.
import { generateKeyPairSync, randomUUID } from 'node:crypto';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { getConnectionToken } from '@nestjs/mongoose';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { Test } from '@nestjs/testing';
import { type Connection, Types } from 'mongoose';
import request from 'supertest';
import { buildAdminDocument } from '../../../scripts/seed-admin.ts';
import { OrderExpirationService } from '../src/modules/order/services/order-expiration.service.js';

const PASSWORD = 'Segura12345';
const RUN = randomUUID().slice(0, 8);
const email = (name: string) => `e2e-${name}-${RUN}@test.co`;
const ZERO_ID = '000000000000000000000000';

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

type Method = 'get' | 'post' | 'put' | 'patch' | 'delete';
type Opts = { body?: object; token?: string; headers?: Record<string, string> };
type Json = Record<string, any>;

describe('order (e2e)', () => {
  let app: NestExpressApplication;
  let conn: Connection;
  let events: EventEmitter2;
  let expiration: OrderExpirationService;

  let adminToken: string;
  let productor: { id: string; token: string };
  let productor2: { id: string; token: string };
  let prov1: { id: string; token: string; storeId: string };
  let prov2: { id: string; token: string; storeId: string };
  let prov3: { id: string; token: string };
  let categoryId: string;

  /** Productos creados por la API en cada tienda. */
  let v1: string; // tienda 1, 10000, stock 10
  let v2: string; // tienda 2, precio 5000, oferta 4000, stock 10
  let vQuote: string; // requiresQuote

  /** Todos los pedidos de la suite, para limpiarlos. */
  const orderIds = new Set<string>();
  /** Eventos `stock.*` emitidos durante la suite. */
  const emitted: Json[] = [];

  let ipCounter = 0;
  const nextIp = () =>
    `10.40.${Math.floor(++ipCounter / 250)}.${(ipCounter % 250) + 1}`;

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
  const variantDoc = (id: string) =>
    conn.collection('product_variants').findOne({ _id: oid(id) });
  const reservation = (orderId: string) =>
    conn.collection('stock_reservations').findOne({ orderId });
  const outboxOf = (orderId: string, type: string) =>
    conn
      .collection('outbox_events')
      .find({ correlationId: orderId, type })
      .toArray();

  const waitStatus = (orderId: string, status: string) =>
    waitFor(async () => {
      const doc = await orderDoc(orderId);
      expect(doc?.status).toBe(status);
      return doc!;
    });
  const waitPublished = (orderId: string, type: string) =>
    waitFor(async () => {
      const [evento] = await outboxOf(orderId, type);
      expect(evento?.status).toBe('PUBLISHED');
      return evento;
    });

  /** Emite un evento de `payments` y espera a que los listeners terminen. */
  const emitPayment = (
    type: 'payment.approved' | 'payment.declined',
    orderId: string,
    eventId = `e2e-${RUN}-${randomUUID()}`,
  ) =>
    events.emitAsync(type, {
      eventId,
      type,
      occurredAt: new Date().toISOString(),
      correlationId: orderId,
      payload:
        type === 'payment.approved'
          ? { orderId, paymentId: 'p1', monto: 0 }
          : { orderId, paymentId: 'p1', motivo: 'FONDOS' },
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

  /** Producto con una variante en la tienda del proveedor dado. */
  async function nuevaVariante(
    token: string,
    variante: Json = {},
    producto: Json = {},
  ): Promise<string> {
    const p = await call('post', '/catalog/products', {
      token,
      body: {
        categoryId,
        nombre: `e2e-${RUN}-producto`,
        marca: 'Agro',
        fichaTecnica: { ingrediente: 'x' },
        ...producto,
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

  const put = (token: string, variantId: string, cantidad: number) =>
    call('put', `/orders/cart/items/${variantId}`, {
      token,
      body: { cantidad },
    });
  const checkout = (token: string, key = `key-${randomUUID()}`) =>
    call('post', '/orders/checkout', {
      token,
      headers: { 'Idempotency-Key': key },
    });

  /** Carrito con las variantes dadas, checkout y pedido en AWAITING_PAYMENT. */
  async function pedidoEnEsperaDePago(
    lineas: [string, number][],
    buyer = productor,
  ): Promise<Json> {
    await call('delete', '/orders/cart', { token: buyer.token });
    for (const [variantId, cantidad] of lineas) {
      expect((await put(buyer.token, variantId, cantidad)).status).toBe(200);
    }
    const res = await checkout(buyer.token);
    expect(res.status).toBe(201);
    orderIds.add(res.body.id);
    await waitStatus(res.body.id, 'AWAITING_PAYMENT');
    return res.body;
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
    const p2 = await register('prov2', 'PROVEEDOR');
    prov3 = await register('prov3', 'PROVEEDOR'); // sin tienda
    prov1 = await withStore(p1, 'tienda1');
    prov2 = await withStore(p2, 'tienda2');

    const cat = await call('post', '/catalog/categories', {
      token: adminToken,
      body: { nombre: `e2e-${RUN}-semillas` },
    });
    categoryId = cat.body.id;

    v1 = await nuevaVariante(prov1.token, { precio: 10000, stock: 10 });
    v2 = await nuevaVariante(prov2.token, {
      precio: 5000,
      precioOferta: 4000,
      stock: 10,
    });
    vQuote = await nuevaVariante(prov1.token, {}, { requiresQuote: true });
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
    // Idempotencia de `catalog` (eventos del outbox) y de `order` (stock.* y pagos).
    await conn
      .collection('processed_events')
      .deleteMany({ eventId: { $in: outbox.map((e) => e.eventId) } });
    await conn.collection('order_processed_events').deleteMany({
      $or: [
        {
          eventId: {
            $in: emitted
              .filter((e) => ids.includes(e.correlationId))
              .map((e) => e.eventId),
          },
        },
        { eventId: new RegExp(`^e2e-${RUN}-`) },
      ],
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
    await conn.collection('notification_outbox').deleteMany({
      correlationId: { $in: [...ids, ...userIds.map(String)] },
    });
    await conn.collection('users').deleteMany({ _id: { $in: userIds } });
    await app.close();
  });

  describe('acceso por token y por rol', () => {
    it.each([
      ['get', '/orders'],
      ['get', `/orders/${ZERO_ID}`],
      ['get', '/orders/cart'],
      ['put', `/orders/cart/items/${ZERO_ID}`],
      ['delete', `/orders/cart/items/${ZERO_ID}`],
      ['delete', '/orders/cart'],
      ['post', '/orders/checkout'],
      ['get', '/orders/provider/sub-orders'],
      ['get', `/orders/provider/sub-orders/${ZERO_ID}`],
      ['get', '/orders/admin'],
      ['get', `/orders/admin/${ZERO_ID}`],
    ] as [Method, string][])('%s %s sin token da 401', async (m, ruta) => {
      expect((await call(m, ruta)).status).toBe(401);
    });

    it('PRODUCTOR recibe 403 en /orders/provider/* y /orders/admin*', async () => {
      for (const ruta of [
        '/orders/provider/sub-orders',
        `/orders/provider/sub-orders/${ZERO_ID}`,
        '/orders/admin',
        `/orders/admin/${ZERO_ID}`,
      ]) {
        expect(
          (await call('get', ruta, { token: productor.token })).status,
        ).toBe(403);
      }
    });

    it('PROVEEDOR y ADMIN reciben 403 en carrito y checkout', async () => {
      for (const token of [prov1.token, adminToken]) {
        expect((await call('get', '/orders/cart', { token })).status).toBe(403);
        expect((await put(token, v1, 1)).status).toBe(403);
        expect((await call('delete', '/orders/cart', { token })).status).toBe(
          403,
        );
        expect((await checkout(token)).status).toBe(403);
      }
    });
  });

  describe('carrito', () => {
    it('PUT con la misma cantidad dos veces deja una sola línea con esa cantidad', async () => {
      expect((await put(productor2.token, v1, 3)).status).toBe(200);
      expect((await put(productor2.token, v1, 3)).status).toBe(200);

      const cart = await call('get', '/orders/cart', {
        token: productor2.token,
      });
      expect(cart.status).toBe(200);
      expect(cart.body.items).toHaveLength(1);
      expect(cart.body.items[0].cantidad).toBe(3);
    });

    it('GET /orders/cart devuelve el precioVigente de catalog (oferta incluida) y apta actual', async () => {
      await put(productor2.token, v2, 2);

      const cart = await call('get', '/orders/cart', {
        token: productor2.token,
      });

      const l1 = cart.body.items.find((i: Json) => i.variantId === v1);
      const l2 = cart.body.items.find((i: Json) => i.variantId === v2);
      expect(l1).toMatchObject({ precioVigente: 10000, apta: true });
      expect(l2).toMatchObject({ precioVigente: 4000, apta: true });
      expect(cart.body.total).toBe(3 * 10000 + 2 * 4000);
    });

    it('una variante inexistente o requiresQuote devuelve 400', async () => {
      expect((await put(productor2.token, ZERO_ID, 1)).status).toBe(400);
      expect((await put(productor2.token, vQuote, 1)).status).toBe(400);
    });

    it.each([0, 1001])('cantidad %i devuelve 400', async (cantidad) => {
      expect((await put(productor2.token, v1, cantidad)).status).toBe(400);
    });

    it('una propiedad de más o {"$ne": null} devuelve 400', async () => {
      const extra = await call('put', `/orders/cart/items/${v1}`, {
        token: productor2.token,
        body: { cantidad: 1, precio: 1 },
      });
      const operador = await call('put', `/orders/cart/items/${v1}`, {
        token: productor2.token,
        body: { cantidad: { $ne: null } },
      });
      expect(extra.status).toBe(400);
      expect(operador.status).toBe(400);
    });

    it('la línea 51 devuelve 400', async () => {
      const cart = await conn
        .collection('carts')
        .findOne({ buyerId: oid(productor2.id) });
      await conn.collection('cart_items').deleteMany({ cartId: cart!._id });
      await conn.collection('cart_items').insertMany(
        Array.from({ length: 50 }, () => ({
          cartId: cart!._id,
          variantId: new Types.ObjectId(),
          cantidad: 1,
          createdAt: new Date(),
          updatedAt: new Date(),
        })),
      );

      expect((await put(productor2.token, v1, 1)).status).toBe(400);
      await call('delete', '/orders/cart', { token: productor2.token });
    });

    it('DELETE de una línea es idempotente y DELETE /orders/cart vacía el carrito', async () => {
      await put(productor2.token, v1, 1);

      expect(
        (
          await call('delete', `/orders/cart/items/${v1}`, {
            token: productor2.token,
          })
        ).status,
      ).toBe(204);
      expect(
        (
          await call('delete', `/orders/cart/items/${v1}`, {
            token: productor2.token,
          })
        ).status,
      ).toBe(204);
      await put(productor2.token, v2, 1);
      expect(
        (await call('delete', '/orders/cart', { token: productor2.token }))
          .status,
      ).toBe(204);
      const cart = await call('get', '/orders/cart', {
        token: productor2.token,
      });
      expect(cart.body.items).toEqual([]);
    });
  });

  describe('checkout, saga y outbox', () => {
    let order: Json;
    let orderKey: string;

    it('sin Idempotency-Key devuelve 400', async () => {
      const res = await call('post', '/orders/checkout', {
        token: productor.token,
      });
      expect(res.status).toBe(400);
    });

    it('un carrito vacío devuelve 400', async () => {
      await call('delete', '/orders/cart', { token: productor.token });
      expect((await checkout(productor.token)).status).toBe(400);
    });

    it('un carrito con un requiresQuote devuelve 400 con el detalle y no crea pedido', async () => {
      await call('delete', '/orders/cart', { token: productor.token });
      await put(productor.token, v1, 1);
      const cart = await conn
        .collection('carts')
        .findOne({ buyerId: oid(productor.id) });
      await conn.collection('cart_items').insertOne({
        cartId: cart!._id,
        variantId: oid(vQuote),
        cantidad: 1,
        createdAt: new Date(),
        updatedAt: new Date(),
      });
      const antes = await conn
        .collection('orders')
        .countDocuments({ buyerId: oid(productor.id) });

      const res = await checkout(productor.token);

      expect(res.status).toBe(400);
      expect(res.body.lineas).toEqual([
        { variantId: vQuote, motivo: 'NOT_APTA' },
      ]);
      expect(
        await conn
          .collection('orders')
          .countDocuments({ buyerId: oid(productor.id) }),
      ).toBe(antes);
      await call('delete', '/orders/cart', { token: productor.token });
    });

    it('crea el pedido PENDING con precio de catalog, un SubOrder por tienda y vacía el carrito', async () => {
      await put(productor.token, v1, 2);
      await put(productor.token, v2, 3);
      orderKey = `key-${randomUUID()}`;

      const res = await call('post', '/orders/checkout', {
        token: productor.token,
        headers: { 'Idempotency-Key': orderKey },
        // un precio enviado por el cliente se ignora: el checkout no tiene body
        body: { precio: 1 },
      });

      expect(res.status).toBe(201);
      order = res.body;
      orderIds.add(order.id);
      expect(order.status).toBe('PENDING');
      expect(order.moneda).toBe('COP');
      expect(order.total).toBe(2 * 10000 + 3 * 4000);
      expect(order.subOrders).toHaveLength(2);
      const items = order.subOrders.flatMap((s: Json) => s.items);
      expect(
        items
          .map((i: Json) => i.precioUnitario)
          .sort((a: number, b: number) => a - b),
      ).toEqual([4000, 10000]);

      const cart = await call('get', '/orders/cart', {
        token: productor.token,
      });
      expect(cart.body.items).toEqual([]);
    });

    it('deja order.created en outbox_events con orderId e items', async () => {
      const [evento] = await outboxOf(order.id, 'order.created');

      expect(evento.eventId).toMatch(/^[0-9a-f-]{36}$/);
      expect(evento.payload.orderId).toBe(order.id);
      expect(evento.payload.items).toEqual(
        expect.arrayContaining([
          { variantId: v1, cantidad: 2 },
          { variantId: v2, cantidad: 3 },
        ]),
      );
    });

    it('repetir la Idempotency-Key devuelve 200 con el mismo pedido y no crea otro order.created', async () => {
      // La carrito está vacío: sin la clave repetida daría 400.
      const res = await call('post', '/orders/checkout', {
        token: productor.token,
        headers: { 'Idempotency-Key': orderKey },
      });

      expect(res.status).toBe(200);
      expect(res.body.id).toBe(order.id);
      expect(await outboxOf(order.id, 'order.created')).toHaveLength(1);
      expect(
        await conn.collection('orders').countDocuments({
          buyerId: oid(productor.id),
          idempotencyKey: orderKey,
        }),
      ).toBe(1);
    });

    it('el outbox publica order.created y catalog reserva: el pedido pasa a AWAITING_PAYMENT con expiresAt a 15 min', async () => {
      const doc = await waitStatus(order.id, 'AWAITING_PAYMENT');

      const minutos = (doc.expiresAt.getTime() - Date.now()) / 60_000;
      expect(minutos).toBeGreaterThan(14);
      expect(minutos).toBeLessThanOrEqual(15);
      expect((await reservation(order.id))?.status).toBe('RESERVED');
      expect((await variantDoc(v1))?.stockReservado).toBe(2);
      expect((await variantDoc(v2))?.stockReservado).toBe(3);
      const publicado = await waitPublished(order.id, 'order.created');
      expect(publicado.publishedAt).toBeInstanceOf(Date);
    });

    it('cambiar precio y nombre en catalog después del checkout no cambia el OrderItem', async () => {
      const antes = await call('get', `/orders/${order.id}`, {
        token: productor.token,
      });
      const productId = antes.body.subOrders[0].items[0].productId;
      const variantId = antes.body.subOrders[0].items[0].variantId;
      const owner =
        antes.body.subOrders[0].storeId === prov1.storeId ? prov1 : prov2;
      await call('patch', `/catalog/variants/${variantId}`, {
        token: owner.token,
        body: { precio: 99999 },
      });
      await call('patch', `/catalog/products/${productId}`, {
        token: owner.token,
        body: { nombre: `e2e-${RUN}-renombrado` },
      });

      const despues = await call('get', `/orders/${order.id}`, {
        token: productor.token,
      });

      expect(despues.body.total).toBe(antes.body.total);
      expect(despues.body.subOrders[0].items[0]).toEqual(
        antes.body.subOrders[0].items[0],
      );
    });

    it('payment.approved confirma el pedido, escribe order.confirmed y catalog confirma el stock', async () => {
      const eventId = `e2e-${RUN}-${randomUUID()}`;

      await emitPayment('payment.approved', order.id, eventId);

      await waitStatus(order.id, 'CONFIRMED');
      await waitPublished(order.id, 'order.confirmed');
      await waitFor(async () => {
        expect((await reservation(order.id))?.status).toBe('CONFIRMED');
      });
      const var1 = await variantDoc(v1);
      expect(var1?.stock).toBe(8);
      expect(var1?.stockReservado).toBe(0);

      // Reenviar el mismo eventId no repite la transición ni el outbox.
      await emitPayment('payment.approved', order.id, eventId);
      expect(await outboxOf(order.id, 'order.confirmed')).toHaveLength(1);
    });

    it('payment.declined no cambia el estado', async () => {
      const otro = await pedidoEnEsperaDePago([[v1, 1]]);

      await emitPayment('payment.declined', otro.id);

      expect((await orderDoc(otro.id))?.status).toBe('AWAITING_PAYMENT');
    });
  });

  describe('cancelación y expiración', () => {
    it('stock.rejected cancela el pedido (STOCK_REJECTED) y deja order.cancelled', async () => {
      const escaso = await nuevaVariante(prov1.token, { stock: 1 });
      await call('delete', '/orders/cart', { token: productor.token });
      await put(productor.token, escaso, 2);
      const res = await checkout(productor.token);
      expect(res.status).toBe(201);
      orderIds.add(res.body.id);

      const doc = await waitStatus(res.body.id, 'CANCELLED');

      expect(doc.cancelReason).toBe('STOCK_REJECTED');
      await waitPublished(res.body.id, 'order.cancelled');
      expect((await variantDoc(escaso))?.stockReservado).toBe(0);
    });

    it('un AWAITING_PAYMENT vencido se cancela con EXPIRED y catalog libera el stock', async () => {
      const antes = (await variantDoc(v1))?.stockReservado ?? 0;
      const pedido = await pedidoEnEsperaDePago([[v1, 2]]);
      expect((await variantDoc(v1))?.stockReservado).toBe(antes + 2);
      await conn
        .collection('orders')
        .updateOne(
          { _id: oid(pedido.id) },
          { $set: { expiresAt: new Date(Date.now() - 1000) } },
        );

      await expiration.expireOrders();

      const doc = await orderDoc(pedido.id);
      expect(doc?.status).toBe('CANCELLED');
      expect(doc?.cancelReason).toBe('EXPIRED');
      const [evento] = await outboxOf(pedido.id, 'order.cancelled');
      expect(evento.payload.motivo).toBe('EXPIRED');
      await waitFor(async () => {
        expect((await reservation(pedido.id))?.status).toBe('RELEASED');
        expect((await variantDoc(v1))?.stockReservado).toBe(antes);
      });

      // Un pago que llega después no reabre el pedido.
      await emitPayment('payment.approved', pedido.id);
      expect((await orderDoc(pedido.id))?.status).toBe('CANCELLED');
      expect(await outboxOf(pedido.id, 'order.confirmed')).toHaveLength(0);
    });

    it('pago tardío: payment.approved confirma aunque expiresAt ya pasó, y la expiración no lo cancela', async () => {
      const pedido = await pedidoEnEsperaDePago([[v1, 1]]);
      await conn
        .collection('orders')
        .updateOne(
          { _id: oid(pedido.id) },
          { $set: { expiresAt: new Date(Date.now() - 1000) } },
        );

      await emitPayment('payment.approved', pedido.id);
      await expiration.expireOrders();

      expect((await orderDoc(pedido.id))?.status).toBe('CONFIRMED');
      expect(await outboxOf(pedido.id, 'order.cancelled')).toHaveLength(0);
      expect(await outboxOf(pedido.id, 'order.confirmed')).toHaveLength(1);
    });

    it('un PENDING sin respuesta de catalog en 5 min se cancela con STOCK_TIMEOUT y una reserva tardía se libera', async () => {
      const fantasma = new Types.ObjectId();
      const diezMinutos = new Date(Date.now() - 10 * 60 * 1000);
      orderIds.add(fantasma.toString());
      await conn.collection('orders').insertOne({
        _id: fantasma,
        buyerId: oid(productor.id),
        total: 10000,
        moneda: 'COP',
        status: 'PENDING',
        idempotencyKey: `key-${randomUUID()}`,
        createdAt: diezMinutos,
        updatedAt: diezMinutos,
      });
      // Un PENDING reciente no se toca.
      const reciente = new Types.ObjectId();
      orderIds.add(reciente.toString());
      await conn.collection('orders').insertOne({
        _id: reciente,
        buyerId: oid(productor.id),
        total: 10000,
        moneda: 'COP',
        status: 'PENDING',
        idempotencyKey: `key-${randomUUID()}`,
        createdAt: new Date(),
        updatedAt: new Date(),
      });

      await expiration.expireOrders();

      const doc = await orderDoc(fantasma.toString());
      expect(doc?.status).toBe('CANCELLED');
      expect(doc?.cancelReason).toBe('STOCK_TIMEOUT');
      expect((await orderDoc(reciente.toString()))?.status).toBe('PENDING');

      // `catalog` responde tarde: se re-emite order.cancelled para que libere.
      const eventId = `e2e-${RUN}-${randomUUID()}`;
      await events.emitAsync('stock.reserved', {
        eventId,
        type: 'stock.reserved',
        occurredAt: new Date().toISOString(),
        correlationId: fantasma.toString(),
        payload: { orderId: fantasma.toString(), items: [] },
      });
      const cancelados = await outboxOf(fantasma.toString(), 'order.cancelled');
      expect(
        cancelados
          .map((e) => String(e.payload.motivo))
          .sort((a, b) => a.localeCompare(b)),
      ).toEqual(['LATE_RESERVATION', 'STOCK_TIMEOUT']);
    });
  });

  describe('visibilidad por rol', () => {
    let pagado: Json; // CONFIRMED: el pedido de dos tiendas del flujo anterior
    let sinPagar: Json; // AWAITING_PAYMENT con ítems de la tienda 1

    beforeAll(async () => {
      const lista = await call('get', '/orders?status=CONFIRMED&limit=100', {
        token: productor.token,
      });
      pagado = lista.body.data.find((o: Json) => o.total === 32000);
      sinPagar = await pedidoEnEsperaDePago([[v1, 1]]);
    });

    it('GET /orders devuelve solo los del PRODUCTOR, con limit 20 por defecto; limit=101 da 400', async () => {
      const mio = await call('get', '/orders', { token: productor.token });
      const ajeno = await call('get', '/orders', { token: productor2.token });

      expect(mio.status).toBe(200);
      expect(mio.body.limit).toBe(20);
      expect(mio.body.total).toBeGreaterThan(0);
      expect(ajeno.body.total).toBe(0);
      expect(
        (await call('get', '/orders?limit=101', { token: productor.token }))
          .status,
      ).toBe(400);
    });

    it('GET /orders/:id de un pedido ajeno devuelve 404', async () => {
      expect(
        (await call('get', `/orders/${pagado.id}`, { token: productor2.token }))
          .status,
      ).toBe(404);
      expect(
        (await call('get', `/orders/${pagado.id}`, { token: productor.token }))
          .status,
      ).toBe(200);
    });

    it('PROVEEDOR ve solo el SubOrder de su tienda, del pedido pagado, sin buyerId ni total', async () => {
      const lista = await call('get', '/orders/provider/sub-orders', {
        token: prov1.token,
      });

      expect(lista.status).toBe(200);
      const mio = lista.body.data.find((s: Json) => s.orderId === pagado.id);
      expect(mio).toBeDefined();
      expect(mio.status).toBe('CONFIRMED');
      expect(JSON.stringify(lista.body)).not.toContain('buyerId');
      expect(mio.items.every((i: Json) => i.variantId === v1)).toBe(true);

      const detalle = await call(
        'get',
        `/orders/provider/sub-orders/${mio.id}`,
        {
          token: prov1.token,
        },
      );
      expect(detalle.status).toBe(200);
      expect(Object.keys(detalle.body)).not.toContain('buyerId');
      expect(Object.keys(detalle.body)).not.toContain('total');
      expect(JSON.stringify(detalle.body)).not.toContain(prov2.storeId);

      // La tienda 2 no ve el sub-pedido de la tienda 1.
      expect(
        (
          await call('get', `/orders/provider/sub-orders/${mio.id}`, {
            token: prov2.token,
          })
        ).status,
      ).toBe(404);
    });

    it('un sub-pedido sin pagar no aparece en la lista y su detalle da 404', async () => {
      const sub = await conn
        .collection('sub_orders')
        .findOne({ orderId: oid(sinPagar.id) });

      const lista = await call('get', '/orders/provider/sub-orders?limit=100', {
        token: prov1.token,
      });

      expect(lista.body.data.some((s: Json) => s.orderId === sinPagar.id)).toBe(
        false,
      );
      expect(
        (
          await call('get', `/orders/provider/sub-orders/${String(sub!._id)}`, {
            token: prov1.token,
          })
        ).status,
      ).toBe(404);
    });

    it('un PROVEEDOR sin tienda recibe lista vacía y 404 en el detalle', async () => {
      const lista = await call('get', '/orders/provider/sub-orders', {
        token: prov3.token,
      });
      expect(lista.status).toBe(200);
      expect(lista.body.total).toBe(0);
      expect(
        (
          await call('get', `/orders/provider/sub-orders/${ZERO_ID}`, {
            token: prov3.token,
          })
        ).status,
      ).toBe(404);
    });

    it('ADMIN lista todos con filtros status y buyerId y ve el detalle completo', async () => {
      const todos = await call('get', '/orders/admin?limit=100', {
        token: adminToken,
      });
      const confirmados = await call(
        'get',
        `/orders/admin?status=CONFIRMED&buyerId=${productor.id}&limit=100`,
        { token: adminToken },
      );
      const deOtro = await call(
        'get',
        `/orders/admin?buyerId=${productor2.id}`,
        {
          token: adminToken,
        },
      );

      expect(todos.status).toBe(200);
      expect(todos.body.data.some((o: Json) => o.id === pagado.id)).toBe(true);
      expect(confirmados.body.data.length).toBeGreaterThan(0);
      expect(
        confirmados.body.data.every(
          (o: Json) => o.status === 'CONFIRMED' && o.buyerId === productor.id,
        ),
      ).toBe(true);
      expect(deOtro.body.total).toBe(0);

      const detalle = await call('get', `/orders/admin/${pagado.id}`, {
        token: adminToken,
      });
      expect(detalle.status).toBe(200);
      expect(detalle.body.buyerId).toBe(productor.id);
      expect(detalle.body.subOrders).toHaveLength(2);
    });

    it('ADMIN no puede modificar pedidos', async () => {
      for (const [m, ruta] of [
        ['post', `/orders/admin/${pagado.id}`],
        ['patch', `/orders/admin/${pagado.id}`],
        ['delete', `/orders/admin/${pagado.id}`],
      ] as [Method, string][]) {
        expect([403, 404]).toContain(
          (await call(m, ruta, { token: adminToken })).status,
        );
      }
      expect((await orderDoc(pagado.id))?.status).toBe('CONFIRMED');
    });
  });
});

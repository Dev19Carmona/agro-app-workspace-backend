// E2E del módulo catalog contra MongoDB real: tiendas, `storeId` en `User`,
// productos, consulta pública, stock y la saga de reserva con eventos de `order`.
//
// - Necesita MONGODB_URI (entorno o `.env`) y un MongoDB en replica set
//   (`docker compose up -d --wait`): la reserva usa transacciones.
// - Las claves JWT las genera la propia suite.
// - `api` usa la base fija `mini-croper`. La suite solo crea datos con el
//   prefijo `e2e-` + el id de ejecución y los borra al terminar (si se corta,
//   pueden quedar).
// - Cada petición usa su propia IP (`X-Forwarded-For` con `trust proxy` solo
//   en la suite) para no chocar con el throttler.
import { generateKeyPairSync, randomUUID } from 'node:crypto';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { getConnectionToken } from '@nestjs/mongoose';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { Test } from '@nestjs/testing';
import { type Connection, Types } from 'mongoose';
import request from 'supertest';
import { buildAdminDocument } from '../../../scripts/seed-admin.ts';
import { CatalogQueryService } from '../src/modules/catalog/index.js';

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

type Method = 'get' | 'post' | 'patch';
type Opts = { body?: object; token?: string };
type Json = Record<string, any>;

const decode = (jwt: string): Json =>
  JSON.parse(Buffer.from(jwt.split('.')[1], 'base64url').toString());

describe('catalog (e2e)', () => {
  let app: NestExpressApplication;
  let conn: Connection;
  let events: EventEmitter2;
  let catalogQuery: CatalogQueryService;

  let adminToken: string;
  let productorToken: string;
  let prov1: { id: string; token: string; refreshToken: string };
  let prov2: { id: string; token: string };
  let prov3: { id: string; token: string };
  let store1: Json;
  let store1Status: number;
  let categoryId: string;
  let inactiveCategoryId: string;

  /** Eventos `stock.*` emitidos durante la suite. */
  const emitted: Json[] = [];

  let ipCounter = 0;
  const nextIp = () =>
    `10.30.${Math.floor(++ipCounter / 250)}.${(ipCounter % 250) + 1}`;

  const call = (method: Method, path: string, opts: Opts = {}) => {
    let req = request(app.getHttpServer())
      [method](path)
      .set('X-Forwarded-For', nextIp());
    if (opts.token) req = req.set('Authorization', `Bearer ${opts.token}`);
    return opts.body === undefined ? req : req.send(opts.body);
  };

  async function registerProvider(name: string) {
    const reg = await call('post', '/auth/register', {
      body: {
        email: email(name),
        password: PASSWORD,
        nombre: `Proveedor ${name}`,
        documento: '1020304050',
        rol: 'PROVEEDOR',
        aceptaTratamientoDatos: true,
      },
    });
    expect(reg.status).toBe(201);
    const approve = await call('post', `/auth/users/${reg.body.id}/approve`, {
      token: adminToken,
    });
    expect(approve.status).toBe(200);
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

  const createStore = (token: string, name: string) =>
    call('post', '/catalog/stores', {
      token,
      body: { nombre: `e2e-${RUN}-${name}`, nit: '900123', municipio: 'Pasto' },
    });

  /** Producto con una variante, creados por la API en la tienda de `prov1`. */
  async function nuevaVariante(
    variante: Json = {},
    producto: Json = {},
  ): Promise<{ productId: string; variantId: string }> {
    const p = await call('post', '/catalog/products', {
      token: prov1.token,
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
      token: prov1.token,
      body: {
        presentacion: '4 L',
        unidad: 'L',
        precio: 10000,
        stock: 10,
        ...variante,
      },
    });
    expect(v.status).toBe(201);
    return { productId: p.body.id, variantId: v.body.id };
  }

  const variantDoc = (id: string) =>
    conn
      .collection('product_variants')
      .findOne({ _id: new Types.ObjectId(id) });
  const reservation = (orderId: string) =>
    conn.collection('stock_reservations').findOne({ orderId });
  const stockEventsOf = (orderId: string) =>
    emitted.filter((e) => e.correlationId === orderId);

  const newOrderId = () => `e2e-${RUN}-${randomUUID().slice(0, 8)}`;
  const orderEvent = (
    type: string,
    payload: Json,
    eventId = `e2e-${RUN}-${randomUUID()}`,
  ) => ({
    eventId,
    type,
    occurredAt: new Date().toISOString(),
    correlationId: payload.orderId,
    payload,
  });
  /** Emite y espera a que los listeners terminen. */
  const emit = (type: string, payload: Json, eventId?: string) =>
    events.emitAsync(type, orderEvent(type, payload, eventId));

  /** Reintenta hasta que `fn` deja de lanzar (un listener en memoria es asíncrono). */
  async function eventually<T>(fn: () => Promise<T>): Promise<T> {
    let last: unknown;
    for (let i = 0; i < 40; i++) {
      try {
        return await fn();
      } catch (e) {
        last = e;
        await new Promise((r) => setTimeout(r, 50));
      }
    }
    throw last;
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
    catalogQuery = app.get(CatalogQueryService);
    for (const name of ['stock.reserved', 'stock.rejected', 'stock.released']) {
      events.on(name, (e: Json) => emitted.push(e));
    }

    // ADMIN: igual que el seed, insertado directamente.
    const hash = await app
      .get(PasswordService, { strict: false })
      .hash(PASSWORD);
    await conn
      .collection('users')
      .insertOne(buildAdminDocument(email('admin'), hash));
    const adminLogin = await call('post', '/auth/login', {
      body: { email: email('admin'), password: PASSWORD },
    });
    adminToken = adminLogin.body.accessToken;

    await call('post', '/auth/register', {
      body: {
        email: email('productor'),
        password: PASSWORD,
        nombre: 'Productor',
        documento: '1020304050',
        rol: 'PRODUCTOR',
        aceptaTratamientoDatos: true,
      },
    });
    productorToken = (
      await call('post', '/auth/login', {
        body: { email: email('productor'), password: PASSWORD },
      })
    ).body.accessToken;

    prov1 = await registerProvider('prov1');
    prov2 = await registerProvider('prov2');
    prov3 = await registerProvider('prov3');

    const res = await createStore(prov1.token, 'tienda1');
    store1Status = res.status;
    store1 = res.body;

    const cat = await call('post', '/catalog/categories', {
      token: adminToken,
      body: { nombre: `e2e-${RUN}-semillas` },
    });
    categoryId = cat.body.id;
    const inactiva = await call('post', '/catalog/categories', {
      token: adminToken,
      body: { nombre: `e2e-${RUN}-inactiva` },
    });
    inactiveCategoryId = inactiva.body.id;
    await call('patch', `/catalog/categories/${inactiveCategoryId}`, {
      token: adminToken,
      body: { activa: false },
    });
  });

  afterAll(async () => {
    const users = await conn
      .collection('users')
      .find({ email: new RegExp(`^e2e-.*-${RUN}@test\\.co$`) })
      .toArray();
    const userIds = users.map((u) => u._id);
    const stores = await conn
      .collection('stores')
      .find({ ownerId: { $in: userIds } })
      .toArray();
    const products = await conn
      .collection('products')
      .find({ storeId: { $in: stores.map((s) => s._id) } })
      .toArray();
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
      .collection('stock_reservations')
      .deleteMany({ orderId: new RegExp(`^e2e-${RUN}-`) });
    await conn
      .collection('processed_events')
      .deleteMany({ eventId: new RegExp(`^e2e-${RUN}-`) });
    await conn
      .collection('refresh_tokens')
      .deleteMany({ userId: { $in: userIds } });
    await conn
      .collection('notification_outbox')
      .deleteMany({ correlationId: { $in: userIds.map(String) } });
    await conn.collection('users').deleteMany({ _id: { $in: userIds } });
    await app.close();
  });

  describe('acceso por token y por rol', () => {
    it.each([
      '/catalog/products',
      `/catalog/products/${ZERO_ID}`,
      '/catalog/offers',
      '/catalog/stores',
      `/catalog/stores/${ZERO_ID}`,
      '/catalog/categories',
    ])('GET %s sin token no devuelve 401', async (ruta) => {
      const res = await call('get', ruta);
      // 200, o 404 si el id de relleno no existe: nunca 401.
      expect([200, 404]).toContain(res.status);
    });

    it.each([
      ['get', '/catalog/products'],
      ['get', '/catalog/offers'],
      ['get', '/catalog/stores'],
      ['get', '/catalog/categories'],
    ] as [Method, string][])(
      'GET %s responde 200 sin token',
      async (m, ruta) => {
        expect((await call(m, ruta)).status).toBe(200);
      },
    );

    const privadas: [Method, string][] = [
      ['post', '/catalog/stores'],
      ['get', '/catalog/my-store'],
      ['post', '/catalog/products'],
      ['patch', `/catalog/products/${ZERO_ID}`],
      ['post', `/catalog/products/${ZERO_ID}/variants`],
      ['patch', `/catalog/variants/${ZERO_ID}`],
      ['patch', `/catalog/variants/${ZERO_ID}/stock`],
      ['post', '/catalog/categories'],
      ['patch', `/catalog/categories/${ZERO_ID}`],
      ['get', '/catalog/admin/stores'],
      ['get', `/catalog/admin/stores/${ZERO_ID}`],
      ['patch', `/catalog/admin/stores/${ZERO_ID}`],
      ['post', `/catalog/admin/stores/${ZERO_ID}/deactivate`],
    ];

    it.each(privadas)('%s %s sin token responde 401', async (m, ruta) => {
      expect((await call(m, ruta, { body: {} })).status).toBe(401);
    });

    const deProveedor = privadas.slice(0, 7);
    const deAdmin = privadas.slice(7);

    it.each(deProveedor)('ADMIN recibe 403 en %s %s', async (m, ruta) => {
      expect(
        (await call(m, ruta, { token: adminToken, body: {} })).status,
      ).toBe(403);
    });

    it.each([...deProveedor, ...deAdmin])(
      'PRODUCTOR recibe 403 en %s %s',
      async (m, ruta) => {
        expect(
          (await call(m, ruta, { token: productorToken, body: {} })).status,
        ).toBe(403);
      },
    );

    it.each(deAdmin)('PROVEEDOR recibe 403 en %s %s', async (m, ruta) => {
      expect(
        (await call(m, ruta, { token: prov1.token, body: {} })).status,
      ).toBe(403);
    });
  });

  describe('tienda y storeId', () => {
    it('POST /catalog/stores devuelve 201 con ownerId igual al id del proveedor', () => {
      expect(store1Status).toBe(201);
      expect(store1.ownerId).toBe(prov1.id);
    });

    it('un ownerId en el body devuelve 400', async () => {
      const res = await call('post', '/catalog/stores', {
        token: prov3.token,
        body: { nombre: 'X', nit: '1', municipio: 'Pasto', ownerId: prov2.id },
      });
      expect(res.status).toBe(400);
    });

    it('una segunda tienda del mismo proveedor devuelve 409', async () => {
      expect((await createStore(prov1.token, 'otra')).status).toBe(409);
    });

    it('GET /catalog/my-store devuelve la tienda propia o 404', async () => {
      const propia = await call('get', '/catalog/my-store', {
        token: prov1.token,
      });
      const sinTienda = await call('get', '/catalog/my-store', {
        token: prov3.token,
      });
      expect(propia.status).toBe(200);
      expect(propia.body.id).toBe(store1.id);
      expect(sinTienda.status).toBe(404);
    });

    it('User.storeId queda igual al _id de la tienda y el token renovado lo lleva', async () => {
      await eventually(async () => {
        const user = await conn
          .collection('users')
          .findOne({ email: email('prov1') });
        expect(user?.storeId?.toString()).toBe(store1.id);
      });

      const res = await call('post', '/auth/refresh', {
        body: { refreshToken: prov1.refreshToken },
      });
      expect(res.status).toBe(200);
      expect(decode(res.body.accessToken).storeId).toBe(store1.id);
    });

    it('un proveedor crea productos justo después de crear su tienda, sin renovar el token', async () => {
      const prov = await registerProvider('prov-nuevo');
      expect((await createStore(prov.token, 'nuevo')).status).toBe(201);

      const res = await call('post', '/catalog/products', {
        token: prov.token,
        body: {
          categoryId,
          nombre: `e2e-${RUN}-rapido`,
          marca: 'Agro',
          fichaTecnica: {},
        },
      });
      expect(res.status).toBe(201);
    });

    it('un proveedor sin tienda recibe 403 al crear productos', async () => {
      const res = await call('post', '/catalog/products', {
        token: prov3.token,
        body: { categoryId, nombre: 'X', marca: 'Y', fichaTecnica: {} },
      });
      expect(res.status).toBe(403);
    });

    it('con la tienda desactivada recibe 403 y sale de la consulta pública', async () => {
      const store = (await createStore(prov2.token, 'tienda2')).body;
      const { productId } = await (async () => {
        const p = await call('post', '/catalog/products', {
          token: prov2.token,
          body: {
            categoryId,
            nombre: `e2e-${RUN}-de-tienda2`,
            marca: 'Agro',
            fichaTecnica: {},
          },
        });
        return { productId: p.body.id as string };
      })();

      const antes = await call('get', `/catalog/products/${productId}`);
      expect(antes.status).toBe(200);

      const des = await call(
        'post',
        `/catalog/admin/stores/${store.id}/deactivate`,
        {
          token: adminToken,
        },
      );
      expect(des.status).toBe(200);
      expect(des.body.activa).toBe(false);
      // Idempotente.
      expect(
        (
          await call('post', `/catalog/admin/stores/${store.id}/deactivate`, {
            token: adminToken,
          })
        ).status,
      ).toBe(200);

      const nuevo = await call('post', '/catalog/products', {
        token: prov2.token,
        body: { categoryId, nombre: 'Z', marca: 'Y', fichaTecnica: {} },
      });
      expect(nuevo.status).toBe(403);
      expect((await call('get', `/catalog/products/${productId}`)).status).toBe(
        404,
      );
      expect((await call('get', `/catalog/stores/${store.id}`)).status).toBe(
        404,
      );
      const lista = await call('get', `/catalog/products?storeId=${store.id}`);
      expect(lista.body.data).toEqual([]);
      const admin = await call('get', `/catalog/admin/stores/${store.id}`, {
        token: adminToken,
      });
      expect(admin.body.activa).toBe(false);
    });
  });

  describe('productos, variantes y propiedad', () => {
    it('un producto con storeId en el body devuelve 400', async () => {
      const res = await call('post', '/catalog/products', {
        token: prov1.token,
        body: {
          categoryId,
          nombre: 'X',
          marca: 'Y',
          fichaTecnica: {},
          storeId: store1.id,
        },
      });
      expect(res.status).toBe(400);
    });

    it('un categoryId inexistente o inactivo devuelve 400', async () => {
      for (const id of [ZERO_ID, inactiveCategoryId]) {
        const res = await call('post', '/catalog/products', {
          token: prov1.token,
          body: { categoryId: id, nombre: 'X', marca: 'Y', fichaTecnica: {} },
        });
        expect(res.status).toBe(400);
      }
    });

    it('editar un producto, una variante o el stock de otra tienda devuelve 404', async () => {
      const { productId, variantId } = await nuevaVariante();
      // prov2 ya tiene tienda (desactivada) pero no es dueño de este producto.
      expect(
        (
          await call('patch', `/catalog/products/${productId}`, {
            token: prov2.token,
            body: { nombre: 'robo' },
          })
        ).status,
      ).toBe(404);
      expect(
        (
          await call('post', `/catalog/products/${productId}/variants`, {
            token: prov2.token,
            body: { presentacion: '1 L', unidad: 'L', precio: 5, stock: 1 },
          })
        ).status,
      ).toBe(404);
      expect(
        (
          await call('patch', `/catalog/variants/${variantId}`, {
            token: prov2.token,
            body: { precio: 1 },
          })
        ).status,
      ).toBe(404);
      expect(
        (
          await call('patch', `/catalog/variants/${variantId}/stock`, {
            token: prov2.token,
            body: { stock: 999 },
          })
        ).status,
      ).toBe(404);
      expect((await variantDoc(variantId))?.stock).toBe(10);
    });

    it('precioOferta mayor o igual a precio devuelve 400 y null la elimina', async () => {
      const { productId, variantId } = await nuevaVariante();
      for (const precioOferta of [10000, 12000]) {
        const crear = await call(
          'post',
          `/catalog/products/${productId}/variants`,
          {
            token: prov1.token,
            body: {
              presentacion: '1 L',
              unidad: 'L',
              precio: 10000,
              stock: 1,
              precioOferta,
            },
          },
        );
        expect(crear.status).toBe(400);
      }
      const mala = await call('patch', `/catalog/variants/${variantId}`, {
        token: prov1.token,
        body: { precioOferta: 10000 },
      });
      expect(mala.status).toBe(400);

      const oferta = await call('patch', `/catalog/variants/${variantId}`, {
        token: prov1.token,
        body: { precioOferta: 8000 },
      });
      expect(oferta.status).toBe(200);
      expect(oferta.body.precioVigente).toBe(8000);

      const quitar = await call('patch', `/catalog/variants/${variantId}`, {
        token: prov1.token,
        body: { precioOferta: null },
      });
      expect(quitar.status).toBe(200);
      expect(quitar.body.precioOferta).toBeUndefined();
      expect((await variantDoc(variantId))?.precioOferta).toBeUndefined();
    });

    it('un {"$ne": null} en body, parámetro o query devuelve 400', async () => {
      const operador = { $ne: null };
      const body = await call('post', '/catalog/products', {
        token: prov1.token,
        body: {
          categoryId: operador,
          nombre: 'X',
          marca: 'Y',
          fichaTecnica: {},
        },
      });
      const stock = await call('patch', `/catalog/variants/${ZERO_ID}/stock`, {
        token: prov1.token,
        body: { stock: operador },
      });
      const param = await call(
        'get',
        `/catalog/products/${encodeURIComponent('{"$ne":null}')}`,
      );
      const query = await call('get', '/catalog/products?categoryId[$ne]=');
      expect([body.status, stock.status, param.status, query.status]).toEqual([
        400, 400, 400, 400,
      ]);
    });

    it('un nombre de categoría repetido devuelve 409, no 500', async () => {
      const nombre = `e2e-${RUN}-semillas`;
      const igual = await call('post', '/catalog/categories', {
        token: adminToken,
        body: { nombre },
      });
      const otraCaja = await call('post', '/catalog/categories', {
        token: adminToken,
        body: { nombre: nombre.toUpperCase() },
      });
      expect(igual.status).toBe(409);
      expect(otraCaja.status).toBe(409);
    });
  });

  describe('consulta pública', () => {
    it('devuelve precioVigente y disponible = stock − stockReservado', async () => {
      const { productId, variantId } = await nuevaVariante({
        precioOferta: 7000,
      });
      await conn
        .collection('product_variants')
        .updateOne(
          { _id: new Types.ObjectId(variantId) },
          { $set: { stockReservado: 4 } },
        );

      const res = await call('get', `/catalog/products/${productId}`);

      expect(res.status).toBe(200);
      expect(res.body.variantes[0]).toMatchObject({
        precio: 10000,
        precioVigente: 7000,
        disponible: 6,
      });
    });

    it('una variante con stock igual a stockReservado aparece con disponible 0', async () => {
      const { productId, variantId } = await nuevaVariante({ stock: 5 });
      await conn
        .collection('product_variants')
        .updateOne(
          { _id: new Types.ObjectId(variantId) },
          { $set: { stockReservado: 5 } },
        );

      const res = await call('get', `/catalog/products/${productId}`);

      expect(res.body.variantes).toHaveLength(1);
      expect(res.body.variantes[0].disponible).toBe(0);
    });

    it('un producto o variante inactivos no aparecen', async () => {
      const { productId, variantId } = await nuevaVariante();
      await call('post', `/catalog/products/${productId}/variants`, {
        token: prov1.token,
        body: { presentacion: '1 L', unidad: 'L', precio: 5000, stock: 3 },
      });

      await call('patch', `/catalog/variants/${variantId}`, {
        token: prov1.token,
        body: { activo: false },
      });
      const sinVariante = await call('get', `/catalog/products/${productId}`);
      expect(sinVariante.body.variantes).toHaveLength(1);
      expect(sinVariante.body.variantes.map((v: Json) => v.id)).not.toContain(
        variantId,
      );

      await call('patch', `/catalog/products/${productId}`, {
        token: prov1.token,
        body: { activo: false },
      });
      expect((await call('get', `/catalog/products/${productId}`)).status).toBe(
        404,
      );
      const lista = await call(
        'get',
        `/catalog/products?storeId=${store1.id}&limit=100`,
      );
      expect(lista.body.data.map((p: Json) => p.id)).not.toContain(productId);
    });

    it('GET /catalog/offers solo devuelve variantes con precioOferta', async () => {
      const conOferta = await nuevaVariante({ precioOferta: 6000 });
      const sinOferta = await nuevaVariante();
      const cotizable = await nuevaVariante(
        { precioOferta: 6000 },
        { requiresQuote: true },
      );

      const res = await call(
        'get',
        `/catalog/offers?storeId=${store1.id}&limit=100`,
      );

      const ids = res.body.data.map((v: Json) => v.id);
      expect(res.status).toBe(200);
      expect(ids).toContain(conOferta.variantId);
      expect(ids).not.toContain(sinOferta.variantId);
      expect(ids).not.toContain(cotizable.variantId);
      expect(res.body.data.every((v: Json) => v.precioOferta != null)).toBe(
        true,
      );
    });

    it('limit=101 devuelve 400 y sin limit la página trae como máximo 20', async () => {
      expect((await call('get', '/catalog/products?limit=101')).status).toBe(
        400,
      );
      for (let i = 0; i < 21; i++) {
        await call('post', '/catalog/products', {
          token: prov1.token,
          body: {
            categoryId,
            nombre: `e2e-${RUN}-bulk-${i}`,
            marca: 'Agro',
            fichaTecnica: {},
          },
        });
      }
      const res = await call('get', `/catalog/products?storeId=${store1.id}`);
      expect(res.status).toBe(200);
      expect(res.body.data.length).toBeLessThanOrEqual(20);
      expect(res.body.limit).toBe(20);
      expect(res.body.total).toBeGreaterThan(20);
    });

    it('las categorías inactivas no aparecen en el listado público', async () => {
      const res = await call('get', '/catalog/categories');
      const ids = res.body.map((c: Json) => c.id);
      expect(ids).toContain(categoryId);
      expect(ids).not.toContain(inactiveCategoryId);
    });
  });

  describe('stock manual', () => {
    it('PATCH stock con un valor menor que stockReservado devuelve 409 y no cambia el stock', async () => {
      const { variantId } = await nuevaVariante({ stock: 10 });
      await conn
        .collection('product_variants')
        .updateOne(
          { _id: new Types.ObjectId(variantId) },
          { $set: { stockReservado: 6 } },
        );

      const bajo = await call('patch', `/catalog/variants/${variantId}/stock`, {
        token: prov1.token,
        body: { stock: 5 },
      });
      const igual = await call(
        'patch',
        `/catalog/variants/${variantId}/stock`,
        {
          token: prov1.token,
          body: { stock: 6 },
        },
      );

      expect(bajo.status).toBe(409);
      expect(igual.status).toBe(200);
      expect(igual.body.disponible).toBe(0);
      expect((await variantDoc(variantId))?.stock).toBe(6);
    });
  });

  describe('CatalogQueryService.getCheckoutVariants', () => {
    it('apta es false con requiresQuote, variante o producto inactivos y tienda desactivada', async () => {
      const ok = await nuevaVariante({ precioOferta: 9000 });
      const cotiza = await nuevaVariante({}, { requiresQuote: true });
      const varInactiva = await nuevaVariante();
      await call('patch', `/catalog/variants/${varInactiva.variantId}`, {
        token: prov1.token,
        body: { activo: false },
      });
      const prodInactivo = await nuevaVariante();
      await call('patch', `/catalog/products/${prodInactivo.productId}`, {
        token: prov1.token,
        body: { activo: false },
      });

      const ids = [
        ok.variantId,
        cotiza.variantId,
        varInactiva.variantId,
        prodInactivo.variantId,
        ZERO_ID,
      ];
      const res = await catalogQuery.getCheckoutVariants(ids);
      const apta = Object.fromEntries(res.map((v) => [v.variantId, v.apta]));

      expect(apta[ok.variantId]).toBe(true);
      expect(apta[cotiza.variantId]).toBe(false);
      expect(apta[varInactiva.variantId]).toBe(false);
      expect(apta[prodInactivo.variantId]).toBe(false);
      // Inexistente: ausente del resultado.
      expect(res.map((v) => v.variantId)).not.toContain(ZERO_ID);
      expect(res.find((v) => v.variantId === ok.variantId)).toMatchObject({
        precioVigente: 9000,
        storeId: store1.id,
      });

      // Tienda desactivada: la variante de prov2 (creada antes de desactivarla).
      const store2 = await conn
        .collection('stores')
        .findOne({ ownerId: new Types.ObjectId(prov2.id) });
      const prod2 = await conn
        .collection('products')
        .findOne({ storeId: store2?._id });
      const var2 = await conn.collection('product_variants').insertOne({
        productId: prod2?._id,
        presentacion: '1 L',
        unidad: 'L',
        precio: 1000,
        stock: 5,
        stockReservado: 0,
        activo: true,
      });
      const [desactivada] = await catalogQuery.getCheckoutVariants([
        var2.insertedId.toString(),
      ]);
      expect(desactivada.apta).toBe(false);
      await conn
        .collection('product_variants')
        .deleteOne({ _id: var2.insertedId });
    });
  });

  describe('saga de stock (eventos de order)', () => {
    it('order.created por 4 con 10 de stock reserva y emite stock.reserved', async () => {
      const { variantId } = await nuevaVariante({ stock: 10 });
      const orderId = newOrderId();

      await emit('order.created', {
        orderId,
        items: [{ variantId, cantidad: 4 }],
      });

      expect((await variantDoc(variantId))?.stockReservado).toBe(4);
      expect((await reservation(orderId))?.status).toBe('RESERVED');
      const [evento] = stockEventsOf(orderId);
      expect(evento.type).toBe('stock.reserved');
      expect(evento.correlationId).toBe(orderId);
    });

    it('order.created por 11 deja el stock intacto, guarda REJECTED y emite stock.rejected', async () => {
      const { variantId } = await nuevaVariante({ stock: 10 });
      const orderId = newOrderId();

      await emit('order.created', {
        orderId,
        items: [{ variantId, cantidad: 11 }],
      });

      const doc = await variantDoc(variantId);
      expect(doc?.stock).toBe(10);
      expect(doc?.stockReservado).toBe(0);
      expect((await reservation(orderId))?.status).toBe('REJECTED');
      const [evento] = stockEventsOf(orderId);
      expect(evento.type).toBe('stock.rejected');
      expect(evento.payload.motivo).toBe('INSUFFICIENT_STOCK');
      expect(evento.payload.items).toEqual([
        { variantId, cantidad: 11, disponible: 10 },
      ]);
    });

    it('con dos ítems donde el segundo no alcanza, el primero queda sin modificar', async () => {
      const a = await nuevaVariante({ stock: 10 });
      const b = await nuevaVariante({ stock: 2 });
      const orderId = newOrderId();

      await emit('order.created', {
        orderId,
        items: [
          { variantId: a.variantId, cantidad: 3 },
          { variantId: b.variantId, cantidad: 5 },
        ],
      });

      expect((await variantDoc(a.variantId))?.stockReservado).toBe(0);
      expect((await variantDoc(b.variantId))?.stockReservado).toBe(0);
      expect((await reservation(orderId))?.status).toBe('REJECTED');
      expect(stockEventsOf(orderId)[0].payload.items).toEqual([
        { variantId: b.variantId, cantidad: 5, disponible: 2 },
      ]);
    });

    it('una variante inactiva rechaza con VARIANT_UNAVAILABLE', async () => {
      const { variantId } = await nuevaVariante({ stock: 10 });
      await call('patch', `/catalog/variants/${variantId}`, {
        token: prov1.token,
        body: { activo: false },
      });
      const orderId = newOrderId();

      await emit('order.created', {
        orderId,
        items: [{ variantId, cantidad: 1 }],
      });

      expect(stockEventsOf(orderId)[0].payload.motivo).toBe(
        'VARIANT_UNAVAILABLE',
      );
      expect((await variantDoc(variantId))?.stockReservado).toBe(0);
    });

    it('dos order.created concurrentes que superan el stock reservan solo uno', async () => {
      const { variantId } = await nuevaVariante({ stock: 10 });
      const o1 = newOrderId();
      const o2 = newOrderId();

      await Promise.all([
        emit('order.created', {
          orderId: o1,
          items: [{ variantId, cantidad: 6 }],
        }),
        emit('order.created', {
          orderId: o2,
          items: [{ variantId, cantidad: 6 }],
        }),
      ]);

      const estados = [
        (await reservation(o1))?.status,
        (await reservation(o2))?.status,
      ].sort((a, b) => String(a).localeCompare(String(b)));
      expect(estados).toEqual(['REJECTED', 'RESERVED']);
      expect((await variantDoc(variantId))?.stockReservado).toBe(6);
    });

    it('reenviar el mismo eventId no suma otra reserva ni emite otro evento', async () => {
      const { variantId } = await nuevaVariante({ stock: 10 });
      const orderId = newOrderId();
      const eventId = `e2e-${RUN}-${randomUUID()}`;
      const payload = { orderId, items: [{ variantId, cantidad: 4 }] };

      await emit('order.created', payload, eventId);
      await emit('order.created', payload, eventId);

      expect((await variantDoc(variantId))?.stockReservado).toBe(4);
      expect(stockEventsOf(orderId)).toHaveLength(1);
    });

    it('order.confirmed resta stock y stockReservado y deja la reserva CONFIRMED', async () => {
      const { variantId } = await nuevaVariante({ stock: 10 });
      const orderId = newOrderId();
      await emit('order.created', {
        orderId,
        items: [{ variantId, cantidad: 4 }],
      });

      await emit('order.confirmed', { orderId });
      // Idempotente: una segunda confirmación no descuenta otra vez.
      await emit('order.confirmed', { orderId });

      const doc = await variantDoc(variantId);
      expect(doc?.stock).toBe(6);
      expect(doc?.stockReservado).toBe(0);
      expect((await reservation(orderId))?.status).toBe('CONFIRMED');
    });

    it('order.cancelled sobre RESERVED libera, emite stock.released y una segunda cancelación no libera', async () => {
      const { variantId } = await nuevaVariante({ stock: 10 });
      const orderId = newOrderId();
      await emit('order.created', {
        orderId,
        items: [{ variantId, cantidad: 4 }],
      });

      await emit('order.cancelled', { orderId });
      await emit('order.cancelled', { orderId });

      const doc = await variantDoc(variantId);
      expect(doc?.stock).toBe(10);
      expect(doc?.stockReservado).toBe(0);
      expect((await reservation(orderId))?.status).toBe('RELEASED');
      const liberados = stockEventsOf(orderId).filter(
        (e) => e.type === 'stock.released',
      );
      expect(liberados).toHaveLength(1);
      expect(liberados[0].payload.items).toEqual([{ variantId, cantidad: 4 }]);
    });

    it('order.cancelled sobre REJECTED, CONFIRMED o inexistente no cambia nada ni emite', async () => {
      const { variantId } = await nuevaVariante({ stock: 10 });

      const rechazado = newOrderId();
      await emit('order.created', {
        orderId: rechazado,
        items: [{ variantId, cantidad: 99 }],
      });
      const confirmado = newOrderId();
      await emit('order.created', {
        orderId: confirmado,
        items: [{ variantId, cantidad: 3 }],
      });
      await emit('order.confirmed', { orderId: confirmado });
      const antes = await variantDoc(variantId);

      await emit('order.cancelled', { orderId: rechazado });
      await emit('order.cancelled', { orderId: confirmado });
      await emit('order.cancelled', { orderId: newOrderId() });

      const despues = await variantDoc(variantId);
      expect(despues?.stock).toBe(antes?.stock);
      expect(despues?.stockReservado).toBe(antes?.stockReservado);
      expect((await reservation(rechazado))?.status).toBe('REJECTED');
      expect((await reservation(confirmado))?.status).toBe('CONFIRMED');
      expect(
        [rechazado, confirmado].flatMap(stockEventsOf).map((e) => e.type),
      ).not.toContain('stock.released');
    });

    it('todo evento stock.* lleva eventId, type, occurredAt, correlationId y payload', () => {
      expect(emitted.length).toBeGreaterThan(0);
      for (const e of emitted) {
        expect(e).toEqual({
          eventId: expect.any(String),
          type: expect.stringMatching(/^stock\./),
          occurredAt: expect.any(String),
          correlationId: expect.any(String),
          payload: expect.any(Object),
        });
        expect(Date.parse(e.occurredAt)).not.toBeNaN();
        expect(e.payload.orderId).toBe(e.correlationId);
      }
    });
  });
});

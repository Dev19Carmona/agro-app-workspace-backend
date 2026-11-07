# SPEC 06 — Módulo Catalog (tiendas, productos, variantes y reserva de stock)

> **Status:** Aprobado
> **Depends on:** SPEC 03, SPEC 04
> **Date:** 2026-11-07
> **Objective:** Implementar el módulo `catalog` del monolito `api` (tiendas, categorías, productos, variantes, consulta pública, stock y su reserva, confirmación y liberación por eventos en memoria), incluyendo el listener de `auth` que guarda el `storeId` del PROVEEDOR.

## Por qué existe este spec

`docs/reglas-de-negocio.md` ("Catálogo" y "Saga de pedido") fija las reglas, pero hoy `catalog` es un esqueleto con un `GET /catalog` de ejemplo. `order` no puede escribirse sin una fuente de precio vigente y de disponibilidad, ni sin la reserva de stock de la saga.

Decisiones no obvias que este spec cierra:

- **`storeId` del PROVEEDOR.** SPEC 03 dejó su asignación a `catalog`, pero `catalog` no puede escribir en `users`. `catalog` emite `store.created` y un listener de `auth` actualiza su propio `User`. Por eso este spec toca `auth` en un único punto.
- **Propiedad por `ownerId`.** El access token vive 15 min y no lleva `storeId` hasta que se renueva. `catalog` busca la tienda por `ownerId = user.id`; el claim `storeId` solo es un atajo.
- **Hueco en las reglas.** Las reglas dicen que `order.cancelled` libera stock, pero no qué libera si el pedido se canceló por `stock.rejected`, ni qué hace `order.confirmed` en `catalog`. Este spec fija el comportamiento con la colección propia `stock_reservations` (ver "Reserva, confirmación y liberación"). `docs/reglas-de-negocio.md` debe actualizarse durante la implementación (paso 15).

## Alcance

**Dentro:**

- **Colecciones propias de `catalog`** (Mongoose, base `mini-croper`): `stores`, `categories`, `products`, `product_variants`, `stock_reservations` y `processed_events`, con sus índices.
- **Endpoints públicos** (`@Public()`) bajo `/catalog`: `GET /catalog/products`, `GET /catalog/products/:id`, `GET /catalog/offers`, `GET /catalog/stores`, `GET /catalog/stores/:id` y `GET /catalog/categories`.
- **Endpoints `PROVEEDOR`** (`@Roles(Role.PROVEEDOR)`), solo sobre su tienda:
  - `POST /catalog/stores` y `GET /catalog/my-store`.
  - `POST /catalog/products` y `PATCH /catalog/products/:id`.
  - `POST /catalog/products/:id/variants` y `PATCH /catalog/variants/:id`.
  - `PATCH /catalog/variants/:id/stock`.
- **Endpoints `ADMIN`** (`@Roles(Role.ADMIN)`), solo categorías y tiendas:
  - `POST /catalog/categories` y `PATCH /catalog/categories/:id`.
  - `GET /catalog/admin/stores`, `GET /catalog/admin/stores/:id` y `PATCH /catalog/admin/stores/:id`.
  - `POST /catalog/admin/stores/:id/deactivate`.
- **Una sola tienda por PROVEEDOR**, garantizada con índice único en `stores.ownerId`.
- **Asignación de `storeId`:** `catalog` emite en memoria `store.created`; `auth` lo escucha y fija `User.storeId`. Es el único cambio en `auth`.
- **Precio vigente y disponibilidad:** precio de oferta si existe; disponible = `stock` − `stockReservado`. Un producto con `requiresQuote = true` no es apto para el checkout.
- **Saga de stock:** escucha `order.created`, `order.confirmed` y `order.cancelled`; emite `stock.reserved`, `stock.rejected` y `stock.released`, con reserva transaccional atómica y condicional.
- **Idempotencia de consumidores** con la colección `processed_events`.
- **API pública de `index.ts`:** servicio de consulta para `order`, eventos y tipos.
- **Validación y límites:** DTO Zod estricto, `StandardSchemaValidationPipe` global y el rate limit global de 100 req/min por IP.
- **Documentación:** actualizar `docs/reglas-de-negocio.md` y `CLAUDE.md`.

**Fuera de alcance (para specs futuros):**

- `order` (carrito, checkout, expiración, outbox), `payments` y su efecto en el stock.
- El transporte de eventos hacia `notifications` (RabbitMQ u otro).
- Búsqueda avanzada (texto, ordenamientos complejos, facetas).
- Cotizaciones: un producto `requiresQuote` solo se muestra y se excluye del checkout.
- Logística y envíos.
- Imágenes de productos.
- Reactivar una tienda desactivada y desactivar una categoría con productos asociados (más allá del campo `activa`).
- Endpoint `DELETE` de tiendas, productos o variantes.
- Outbox propio de `catalog` y reintento de eventos `stock.*` perdidos por una caída entre el commit y la emisión (ver Riesgos).
- Moderación de productos por `ADMIN`.

## Modelo de datos

Colecciones propias del módulo `catalog`. Ningún otro módulo las lee directamente.

Los identificadores de código no llevan tildes: `fichaTecnica` y `presentacion` corresponden a `fichaTécnica` y `presentación` del vocabulario de dominio. Los precios son enteros en COP, sin decimales.

```ts
// schemas/store.schema.ts → colección `stores`
type Store = {
  _id: ObjectId;
  nombre: string;
  nit: string;
  ownerId: ObjectId; // User PROVEEDOR; índice único
  municipio: string;
  activa: boolean; // default true; false = fuera de la consulta pública
  createdAt: Date;
  updatedAt: Date;
};

// schemas/category.schema.ts → colección `categories`
type Category = {
  _id: ObjectId;
  nombre: string; // índice único (collation es, strength 2)
  activa: boolean; // default true
  createdAt: Date;
  updatedAt: Date;
};

// schemas/product.schema.ts → colección `products`
type Product = {
  _id: ObjectId;
  storeId: ObjectId;
  categoryId: ObjectId;
  nombre: string;
  marca: string;
  fichaTecnica: Record<string, string>; // máx. 30 entradas, clave ≤ 50, valor ≤ 500
  requiresQuote: boolean; // default false
  activo: boolean; // default true
  createdAt: Date;
  updatedAt: Date;
};

// schemas/product-variant.schema.ts → colección `product_variants`
type ProductVariant = {
  _id: ObjectId;
  productId: ObjectId;
  presentacion: string; // p. ej. "4 L"
  unidad: string; // 1 a 20 caracteres
  precio: number; // entero > 0, COP
  precioOferta?: number; // entero > 0 y < precio
  stock: number; // entero ≥ 0
  stockReservado: number; // entero ≥ 0, default 0; solo lo cambia la saga
  activo: boolean; // default true
  createdAt: Date;
  updatedAt: Date;
};

// schemas/stock-reservation.schema.ts → colección `stock_reservations`
type StockReservation = {
  _id: ObjectId;
  orderId: string; // índice único; correlationId de la saga
  status: 'RESERVED' | 'REJECTED' | 'CONFIRMED' | 'RELEASED';
  items: { variantId: ObjectId; cantidad: number }[];
  createdAt: Date;
  updatedAt: Date;
};

// schemas/processed-event.schema.ts → colección `processed_events`
type ProcessedEvent = {
  _id: ObjectId;
  eventId: string; // índice único
  type: string;
  processedAt: Date;
};
```

Índices:

| Colección | Índice |
| --- | --- |
| `stores` | `{ ownerId: 1 }` único; `{ activa: 1, municipio: 1 }` |
| `categories` | `{ nombre: 1 }` único con collation `es` strength 2 |
| `products` | `{ storeId: 1, activo: 1 }`; `{ categoryId: 1, activo: 1 }` |
| `product_variants` | `{ productId: 1, activo: 1 }`; `{ precioOferta: 1 }` parcial (`precioOferta` existe) |
| `stock_reservations` | `{ orderId: 1 }` único |
| `processed_events` | `{ eventId: 1 }` único |

Un error de clave duplicada (código 11000) se traduce a `409`, nunca a `500`.

### Reglas de precio y disponibilidad

Viven en `policies/pricing.policy.ts` como funciones puras:

```ts
precioVigente = variant.precioOferta ?? variant.precio;
disponible = Math.max(variant.stock - variant.stockReservado, 0);
esApta = variant.activo && product.activo && store.activa && !product.requiresQuote;
```

### Propiedad por recurso

- Toda operación del PROVEEDOR resuelve su tienda con `Store.findOne({ ownerId: user.id })`. El claim `user.storeId` no se usa para autorizar.
- Sin tienda propia, crear productos responde `403`. Con tienda desactivada, también `403`.
- Un producto o variante cuyo `storeId` no sea el de su tienda responde `404` (no revela que existe en otra tienda).
- `categoryId` debe existir y estar `activa`; si no, `400`.
- `ADMIN` no puede llamar a los endpoints de productos ni de stock (`403` por rol).

### Endpoints

Todos los DTO son `z.strictObject`. Los ids de ruta se validan como ObjectId de 24 caracteres hexadecimales.

| Método y ruta | Rol | Notas |
| --- | --- | --- |
| `GET /catalog/products` | público | Query `page` (≥ 1), `limit` (defecto 20, máx. 100), `categoryId?`, `storeId?`, `municipio?`. Solo `activo` de tiendas `activa`. Incluye `requiresQuote`. |
| `GET /catalog/products/:id` | público | Producto con sus variantes activas: `precio`, `precioVigente`, `disponible`. Variante sin stock se muestra con `disponible: 0`. |
| `GET /catalog/offers` | público | Variantes activas con `precioOferta`, de productos activos y no `requiresQuote`. Misma paginación y filtros. |
| `GET /catalog/stores`, `GET /catalog/stores/:id` | público | Solo tiendas `activa`. Paginado como arriba, filtro `municipio?`. |
| `GET /catalog/categories` | público | Solo categorías `activa`. |
| `POST /catalog/stores` | PROVEEDOR | Body `{ nombre, nit, municipio }`. `ownerId` sale del token. Segunda tienda: `409`. Emite `store.created`. |
| `GET /catalog/my-store` | PROVEEDOR | Su tienda, o `404`. |
| `POST /catalog/products` | PROVEEDOR | Body `{ categoryId, nombre, marca, fichaTecnica, requiresQuote? }`. `storeId` sale de su tienda, nunca del body. |
| `PATCH /catalog/products/:id` | PROVEEDOR | Campos opcionales de `Product` salvo `storeId`; incluye `activo`. |
| `POST /catalog/products/:id/variants` | PROVEEDOR | Body `{ presentacion, unidad, precio, precioOferta?, stock }`. |
| `PATCH /catalog/variants/:id` | PROVEEDOR | `presentacion`, `unidad`, `precio`, `precioOferta` (número o `null` para quitarla), `activo`. No toca `stock` ni `stockReservado`. |
| `PATCH /catalog/variants/:id/stock` | PROVEEDOR | Body `{ stock }` (valor absoluto). Si `stock < stockReservado`: `409`. La comparación va en la propia actualización condicional. |
| `POST /catalog/categories`, `PATCH /catalog/categories/:id` | ADMIN | `nombre` y `activa`. Nombre repetido: `409`. |
| `GET /catalog/admin/stores`, `GET /catalog/admin/stores/:id` | ADMIN | Incluyen tiendas desactivadas. Paginado. |
| `PATCH /catalog/admin/stores/:id` | ADMIN | Solo `nombre`, `nit` y `municipio`. |
| `POST /catalog/admin/stores/:id/deactivate` | ADMIN | `activa = false`. Idempotente. |

Los endpoints sin `@Public()` quedan privados por el guard global.

### Eventos

Formato común, con el id del pedido como `correlationId`:

```ts
type DomainEvent<TType extends string, TPayload> = {
  eventId: string; // uuid v4
  type: TType;
  occurredAt: string; // ISO 8601
  correlationId: string; // id del pedido
  payload: TPayload;
};
```

Nombres y payloads en `events/catalog.events.ts`:

```ts
export const CatalogEvents = {
  StoreCreated: 'store.created',
  StockReserved: 'stock.reserved',
  StockRejected: 'stock.rejected',
  StockReleased: 'stock.released',
} as const;

// Eventos que catalog consume (los emite `order`; este spec fija lo mínimo que necesita)
export const ConsumedOrderEvents = {
  OrderCreated: 'order.created',
  OrderConfirmed: 'order.confirmed',
  OrderCancelled: 'order.cancelled',
} as const;

type StockItem = { variantId: string; cantidad: number };
type OrderCreatedPayload = { orderId: string; items: StockItem[] };
type OrderConfirmedPayload = { orderId: string };
type OrderCancelledPayload = { orderId: string };

type StoreCreatedEvent = { storeId: string; ownerId: string }; // sin sobre: evento interno, como los de `auth`
type StockReservedPayload = { orderId: string; items: StockItem[] };
type StockRejectedPayload = {
  orderId: string;
  motivo: 'INSUFFICIENT_STOCK' | 'VARIANT_UNAVAILABLE';
  items: (StockItem & { disponible: number })[]; // solo las que fallaron
};
type StockReleasedPayload = { orderId: string; items: StockItem[] };
```

`store.created` no pertenece a la saga: no lleva sobre ni `correlationId`, igual que los eventos de `auth`. Los tres `stock.*` sí usan el sobre común.

### Reserva, confirmación y liberación

Todas las operaciones corren en una transacción de Mongo (replica set) abierta con `connection.startSession()`. Los eventos `stock.*` se emiten en memoria **después** del commit.

**`order.created`** (con `items` de `order`):

1. Si `processed_events` ya tiene el `eventId`, no hace nada.
2. Por cada ítem, actualización atómica condicional:

```ts
ProductVariant.updateOne(
  {
    _id: variantId,
    activo: true,
    $expr: { $gte: [{ $subtract: ['$stock', '$stockReservado'] }, cantidad] },
  },
  { $inc: { stockReservado: cantidad } },
  { session },
);
```

3. Antes del paso 2 valida que cada variante exista y sea apta (`esApta`). Si no, `VARIANT_UNAVAILABLE`.
4. Si todos los ítems reservan: guarda `stock_reservations` en `RESERVED`, guarda el `eventId` en `processed_events`, confirma y emite `stock.reserved`.
5. Si algún ítem falla (`modifiedCount === 0`): aborta la transacción, así no queda ninguna reserva parcial. En una segunda transacción guarda `stock_reservations` en `REJECTED` y el `eventId`, y emite `stock.rejected` con los ítems que fallaron y su `disponible`.

**`order.confirmed`:** si la reserva está `RESERVED`, por cada ítem hace `stock −= cantidad` y `stockReservado −= cantidad` en una transacción y la pasa a `CONFIRMED`. En cualquier otro estado no hace nada.

**`order.cancelled`:** si la reserva está `RESERVED`, por cada ítem hace `stockReservado −= cantidad`, la pasa a `RELEASED` y emite `stock.released`. Si está `REJECTED`, `CONFIRMED`, `RELEASED` o no existe, no libera nada ni emite.

Un pedido cancelado por `stock.rejected` nunca libera stock, porque su reserva está `REJECTED`.

### API pública de `index.ts`

```ts
export { CatalogModule } from './catalog.module.js';
export { CatalogQueryService } from './services/catalog-query.service.js';
export {
  CatalogEvents,
  ConsumedOrderEvents,
  type StoreCreatedEvent,
  type StockReservedPayload,
  type StockRejectedPayload,
  type StockReleasedPayload,
  type OrderCreatedPayload,
  type OrderConfirmedPayload,
  type OrderCancelledPayload,
  type DomainEvent,
} from './events/catalog.events.js';
export type { CheckoutVariant } from './services/catalog-query.service.js';
```

Propósito de `CatalogQueryService` (solo la interfaz; lo consumirá `order` en el checkout, porque el precio siempre se toma del catálogo):

```ts
type CheckoutVariant = {
  variantId: string;
  productId: string;
  storeId: string;
  nombreProducto: string;
  presentacion: string;
  unidad: string;
  precioVigente: number;
  disponible: number;
  apta: boolean; // false si requiresQuote, inactiva o tienda desactivada
};

getCheckoutVariants(variantIds: string[]): Promise<CheckoutVariant[]>;
```

Una variante inexistente no aparece en el resultado. `order` debe tratar su ausencia o `apta = false` como error de checkout.

### Cambio en `auth`

`auth` añade `services/store-assignment.service.ts` con un `@OnEvent('store.created')`. Importa el nombre y el tipo solo desde `modules/catalog/index.js`. Actualiza así:

```ts
User.updateOne(
  { _id: ownerId, rol: 'PROVEEDOR', storeId: { $exists: false } },
  { $set: { storeId } },
);
```

El `storeId` aparece en el access token al renovar el refresh token. Hasta entonces `catalog` autoriza por `ownerId`.

### Estructura de archivos

```text
apps/api/src/modules/catalog/
  index.ts
  catalog.module.ts
  controllers/
    catalog-public.controller.ts      # consulta pública
    provider-catalog.controller.ts    # tienda, productos, variantes y stock del PROVEEDOR
    catalog-admin.controller.ts       # categorías y tiendas del ADMIN
  services/
    stores.service.ts
    categories.service.ts
    products.service.ts               # productos y variantes
    stock.service.ts                  # PATCH de stock y transacciones de reserva
    stock-listener.service.ts         # @OnEvent de order.*, idempotencia
    catalog-query.service.ts          # API pública para order y consulta pública
  dto/
    store.dto.ts
    category.dto.ts
    product.dto.ts
    variant.dto.ts
    catalog-query.dto.ts
  schemas/
    store.schema.ts
    category.schema.ts
    product.schema.ts
    product-variant.schema.ts
    stock-reservation.schema.ts
    processed-event.schema.ts
  events/
    catalog.events.ts
  policies/
    pricing.policy.ts
  tests/                              # todos los *.spec.ts, planos
apps/api/src/modules/auth/
  services/store-assignment.service.ts
  tests/store-assignment.service.spec.ts
apps/api/test/
  catalog.e2e-spec.ts
```

`catalog.controller.ts` y `catalog.service.ts` del esqueleto se sustituyen por los archivos de arriba, con `git mv` donde corresponda. Cada carpeta se crea solo cuando tiene contenido.

## Plan de implementación

Cada paso deja el sistema compilando y con `npm test` en verde, es commiteable por separado y no supera 30–50 líneas de código de producción (sin contar specs).

1. **Contratos y reglas puras.** Crear `events/catalog.events.ts` y `policies/pricing.policy.ts` (`precioVigente`, `disponible`, `esApta`). Specs: oferta sobre precio, disponible nunca negativo, `requiresQuote` no apta.
2. **Schemas e índices.** Crear los seis schemas de `schemas/` con sus índices y registrarlos en `CatalogModule` con `MongooseModule.forFeature`. Spec que comprueba defaults e índices (patrón de `auth/tests/schemas.spec.ts`).
3. **DTO.** Crear los cinco archivos de `dto/` con `z.strictObject`: ObjectId, paginación (`limit` máx. 100), `precioOferta < precio`, `fichaTecnica` acotada. Spec: rechaza propiedades de más, `{"$ne": null}`, `limit` 101 y `precioOferta ≥ precio`.
4. **Tiendas del PROVEEDOR.** `StoresService.create` y `getMine`, con `POST /catalog/stores` y `GET /catalog/my-store` en `provider-catalog.controller.ts`. Segunda tienda y clave duplicada responden `409`. Emite `store.created` con `EventEmitter2`. Specs de servicio y controlador.
5. **Listener de `auth`.** Crear `auth/services/store-assignment.service.ts` y registrarlo en `AuthModule`; importar el evento solo desde `modules/catalog/index.js`. Spec: asigna a PROVEEDOR sin `storeId`, no sobrescribe uno existente, ignora otros roles.
6. **Categorías.** `CategoriesService` y `catalog-admin.controller.ts` con `POST` y `PATCH` (`@Roles(Role.ADMIN)`). Spec: nombre repetido `409`, rol incorrecto `403`.
7. **Tiendas del ADMIN.** Listado, detalle, `PATCH` de `nombre`/`nit`/`municipio` y `deactivate` (idempotente) en `StoresService` y `catalog-admin.controller.ts`. Specs.
8. **Productos y variantes.** `ProductsService`: crear y editar producto, crear y editar variante, con propiedad por `ownerId` (`403` sin tienda o desactivada, `404` en recurso ajeno, `400` si la categoría no existe o está inactiva). Specs de cada rama.
9. **Stock manual.** `StockService.setStock` con actualización condicional (`stock ≥ stockReservado`) y `PATCH /catalog/variants/:id/stock`. Spec: rechaza `stock` bajo `stockReservado` con `409`, propiedad ajena `404`.
10. **Consulta pública.** `catalog-public.controller.ts` con `@Public()` en los seis `GET`, paginación y filtros, `precioVigente` y `disponible`. Spec: variante sin stock con `disponible: 0`, tienda desactivada fuera, `limit` máximo.
11. **API pública para `order`.** Implementar `CatalogQueryService.getCheckoutVariants`, completar `index.ts` y exportar el servicio desde `CatalogModule`. Spec: oferta, `requiresQuote` con `apta = false`, variante inexistente ausente.
12. **Reserva.** `StockService.reserve` y `StockListenerService` con `@OnEvent('order.created')`: transacción, actualización condicional, `stock_reservations`, `processed_events` y emisión de `stock.reserved` o `stock.rejected` tras el commit. Spec: alcanza, no alcanza (sin reserva parcial), variante no apta, `eventId` repetido.
13. **Confirmación y liberación.** `StockService.confirm` y `release` con `@OnEvent` de `order.confirmed` y `order.cancelled`. Spec: confirmar descuenta `stock` y `stockReservado`; cancelar libera y emite `stock.released`; cancelar un `REJECTED` no libera; doble cancelación no libera dos veces.
14. **E2E.** Crear `apps/api/test/catalog.e2e-spec.ts` con el flujo contra MongoDB (ver criterios): tienda, `storeId` en `User`, productos, consulta pública, reserva, confirmación y liberación emitiendo los eventos de `order` con `EventEmitter2`.
15. **Documentación.** Actualizar `docs/reglas-de-negocio.md` (una tienda por PROVEEDOR, tienda desactivable, `activo` en producto y variante, consulta pública sin variantes inactivas, `stock_reservations`, efecto de `order.confirmed` y `order.cancelled` sobre el stock, fecha e historial) y `CLAUDE.md` (lo que exporta `catalog`, evento `store.created`).

## Criterios de aceptación

- [ ] `GET /catalog/products`, `/catalog/products/:id`, `/catalog/offers`, `/catalog/stores`, `/catalog/stores/:id` y `/catalog/categories` responden 200 sin token.
- [ ] Todos los demás endpoints de `/catalog` responden 401 sin token.
- [ ] `ADMIN` recibe 403 en `POST /catalog/products`, `PATCH /catalog/variants/:id/stock` y los demás endpoints de producto; `PRODUCTOR` recibe 403 en cualquier endpoint de `PROVEEDOR` y de `ADMIN`.
- [ ] `PROVEEDOR` recibe 403 en `POST /catalog/categories` y en `/catalog/admin/*`.
- [ ] `POST /catalog/stores` de un PROVEEDOR devuelve 201 con `ownerId` igual a su id; un `ownerId` en el body devuelve 400.
- [ ] Una segunda `POST /catalog/stores` del mismo PROVEEDOR devuelve 409.
- [ ] Tras crear la tienda, `User.storeId` del PROVEEDOR queda igual al `_id` de la tienda; tras renovar el refresh token, el access token lleva ese `storeId`.
- [ ] `catalog` no importa ni consulta el schema ni la colección `users`; `auth` importa de `catalog` solo `modules/catalog/index.js`.
- [ ] Un PROVEEDOR crea productos justo después de crear su tienda, sin renovar el token.
- [ ] Un PROVEEDOR sin tienda recibe 403 en `POST /catalog/products`; con la tienda desactivada también.
- [ ] Un PROVEEDOR que edita un producto, una variante o el stock de otra tienda recibe 404.
- [ ] `POST /catalog/products` con `storeId` en el body devuelve 400.
- [ ] Un producto con `categoryId` inexistente o inactiva devuelve 400.
- [ ] `precioOferta` mayor o igual a `precio` devuelve 400; `precioOferta: null` en `PATCH` la elimina.
- [ ] `GET /catalog/products/:id` devuelve `precioVigente` igual a `precioOferta` si existe y a `precio` si no, y `disponible` igual a `stock − stockReservado`.
- [ ] Una variante con `stock` igual a `stockReservado` aparece con `disponible: 0`.
- [ ] Un producto o variante con `activo: false` y los productos de una tienda desactivada no aparecen en la consulta pública.
- [ ] `GET /catalog/offers` solo devuelve variantes con `precioOferta`.
- [ ] `limit=101` devuelve 400; sin `limit`, la página trae como máximo 20 elementos.
- [ ] `PATCH /catalog/variants/:id/stock` con `stock` menor que `stockReservado` devuelve 409 y no cambia el stock.
- [ ] `CatalogQueryService.getCheckoutVariants` devuelve `apta: false` para `requiresQuote = true`, para variantes o productos inactivos y para tiendas desactivadas.
- [ ] Con 10 de stock, `order.created` por 4 deja `stockReservado = 4`, guarda la reserva `RESERVED` y emite `stock.reserved` con `correlationId` igual al `orderId`.
- [ ] `order.created` por 11 deja el stock intacto, guarda la reserva `REJECTED` y emite `stock.rejected` con `motivo: INSUFFICIENT_STOCK`.
- [ ] Un `order.created` con dos ítems donde el segundo no alcanza no deja `stockReservado` modificado en el primero.
- [ ] Dos `order.created` concurrentes que juntos superan el stock reservan solo uno.
- [ ] Reenviar el mismo `eventId` de `order.created` no suma una segunda reserva ni emite un segundo evento.
- [ ] `order.confirmed` sobre una reserva `RESERVED` resta la cantidad de `stock` y de `stockReservado` y deja la reserva en `CONFIRMED`.
- [ ] `order.cancelled` sobre una reserva `RESERVED` resta la cantidad de `stockReservado`, deja la reserva en `RELEASED` y emite `stock.released`.
- [ ] `order.cancelled` sobre una reserva `REJECTED`, `CONFIRMED` o inexistente no cambia ningún stock ni emite eventos; una segunda cancelación tampoco libera.
- [ ] Todo evento `stock.*` tiene `eventId`, `type`, `occurredAt`, `correlationId` y `payload`.
- [ ] Un error de clave duplicada de Mongo en tiendas o categorías devuelve 409, no 500.
- [ ] Un `{"$ne": null}` en cualquier body, parámetro o query de `/catalog` devuelve 400 sin consultar Mongo.
- [ ] `catalog` no define outbox propio ni transporte hacia `notifications`.
- [ ] `catalog` cumple la estructura de módulo de `CLAUDE.md`: en la raíz solo `index.ts` y `catalog.module.ts`; carpetas de la lista estándar y sin vacías; todos los `*.spec.ts` planos en `tests/`; ningún módulo importa archivos internos de `catalog`.
- [ ] `docs/reglas-de-negocio.md` documenta las reglas nuevas de este spec y tiene entrada nueva en el historial.
- [ ] `CLAUDE.md` refleja lo que exporta `catalog`.
- [ ] `npm run build:all`, `npm run lint`, `npm test` y `npm run test:e2e` terminan sin errores.

## Decisiones

- **Sí:** `catalog` emite `store.created` y `auth` actualiza su `User`. Cada módulo escribe solo sus colecciones, y `catalog` no depende de `auth`.
- **No:** que `catalog` inyecte un servicio de `auth` o lea `users`. Crearía dependencia directa entre módulos y rompería la propiedad de colecciones.
- **Sí:** autorizar al PROVEEDOR por `ownerId = user.id`; el claim `storeId` es un atajo. El access token dura 15 min y se quedaría sin `storeId` justo tras crear la tienda.
- **No:** confiar solo en `user.storeId`. Obligaría a renovar el token antes de crear el primer producto.
- **Sí:** una tienda por PROVEEDOR, con índice único en `ownerId`. Coincide con el `storeId?` único de `User` y con las reglas.
- **Sí:** `ADMIN` solo gestiona categorías y tiendas. Las reglas dicen que crear productos y modificar stock es del PROVEEDOR sobre su tienda.
- **No:** moderación de productos por `ADMIN`. No está en las reglas.
- **Sí:** el `ADMIN` desactiva tiendas (`activa = false`) sin borrarlas. Sale de la consulta pública y no admite productos nuevos; los pedidos históricos mantienen su referencia.
- **No:** reactivar tiendas ni `DELETE` en este spec. Queda como mejora y evita decidir ahora las consecuencias sobre pedidos.
- **Sí:** `activo` en producto y variante, sin `DELETE`. Un pedido histórico puede referenciarlos.
- **Sí:** `activa` también en `Category`. Mantiene el mismo patrón sin `DELETE`; es la única derivación sin respuesta directa del usuario.
- **Sí:** variante sin stock disponible se muestra con `disponible: 0`. La carrera entre consulta y checkout la cubre `stock.rejected`.
- **No:** ocultar variantes agotadas. El productor vería desaparecer opciones que vuelven al reponer stock.
- **Sí:** paginación `page` y `limit` (20 por defecto, 100 máximo) con filtros `categoryId`, `storeId` y `municipio`, sin texto. Es lo que ya hace `GET /auth/users` y la búsqueda avanzada está fuera de alcance.
- **No:** paginación por cursor. Es más compleja y no se necesita con este volumen.
- **Sí:** `PATCH` de stock con valor absoluto, rechazado si queda por debajo de `stockReservado`. No pisa reservas vivas.
- **No:** ajuste relativo (`delta`). Dos peticiones repetidas duplicarían el efecto.
- **Sí:** reserva con actualización atómica condicional (`$expr`) dentro de una transacción. Es lo que fijan las reglas; evita sobreventa sin bloqueos.
- **Sí:** colección propia `stock_reservations`, una por pedido (índice único en `orderId`). Permite liberar solo lo realmente reservado y que `order.confirmed` y `order.cancelled` sean idempotentes. Cierra el hueco de las reglas.
- **Sí:** `order.confirmed` resta `stock` y `stockReservado`; `order.cancelled` solo libera una reserva `RESERVED`; un cancelado por `stock.rejected` no libera nada.
- **Sí:** `processed_events` con `eventId` único para la idempotencia de consumidores, como exigen las reglas.
- **Sí:** `catalog` emite `stock.*` en memoria después del commit y no tiene outbox propio. El outbox es de `order` y las reglas no lo exigen para `stock.*`.
- **No:** outbox en `catalog`. Reabriría una decisión heredada.
- **Sí:** `CatalogQueryService.getCheckoutVariants` como API pública para `order`. El precio siempre se toma del catálogo, nunca del cliente.
- **No:** que `order` lea `products` ni `product_variants`. La colección es de `catalog`.
- **Sí:** precios enteros en COP. La moneda es COP y no se manejan decimales; evita errores de coma flotante.
- **Sí:** identificadores de código sin tilde (`fichaTecnica`, `presentacion`). Evita problemas de escritura y de consultas Mongo.
- **Sí:** el recurso ajeno responde `404` y no `403`. No revela que existe en otra tienda.
- **Sí:** rate limit global de 100 req/min, sin `@Throttle` propio. Las reglas no fijan un límite específico para `/catalog`.
- **Sí:** `store.created` sin sobre `DomainEvent`. Es un evento interno entre módulos, como los de `auth`, y no pertenece a la saga.
- **Sí:** `docs/reglas-de-negocio.md` se actualiza al implementar (paso 15), no al escribir este spec.

## Riesgos

| Riesgo | Mitigación |
| --- | --- |
| Caída entre el commit de la reserva y la emisión de `stock.*`: el pedido queda en `PENDING` sin respuesta | Aceptado: la reserva queda en `stock_reservations` y se detecta por `orderId`. Un reenvío con otro `eventId` puede reemitir el resultado; el reintento fiable (outbox) queda para un spec posterior. |
| `auth` falla al actualizar `User.storeId` tras crear la tienda | La autorización usa `ownerId`, así que el PROVEEDOR trabaja igual; solo el claim del token queda sin `storeId`. |
| Dos peticiones simultáneas del mismo PROVEEDOR crean dos tiendas | El índice único en `ownerId` hace que la segunda falle con 11000 y se traduzca a 409. |
| `order` emite `order.created` con un payload distinto al que `catalog` espera | Este spec fija `{ orderId, items: [{ variantId, cantidad }] }`; el spec de `order` debe respetarlo o ajustar este contrato. |
| `processed_events` crece sin límite | Aceptado en el alcance actual; un índice TTL puede añadirse después sin cambiar el contrato. |
| Las transacciones fallan si MongoDB no corre como replica set | `docker-compose.yml` ya lo levanta como `rs0`; los e2e lo exigen. |
| `$expr` con `$subtract` no usa índice sobre la variante | La actualización filtra por `_id`, así que el costo es el de una búsqueda por clave primaria. |
| ESM: imports relativos sin `.js` rompen el build | Seguir la convención del repo (`./archivo.js`). |

## Qué **no** está en este spec

- `order` (carrito, checkout, expiración, outbox) y `payments`.
- El transporte de eventos hacia `notifications`.
- Búsqueda avanzada, cotizaciones, logística e imágenes.
- Reactivar tiendas, `DELETE` de recursos y moderación de productos por `ADMIN`.
- Outbox propio de `catalog` y reintento fiable de eventos `stock.*`.

Cada uno de estos, si se aborda, va en su propio spec.

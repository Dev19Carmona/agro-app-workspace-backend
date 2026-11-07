# SPEC 07 — Módulo Order (carrito, checkout, saga, outbox y expiración)

> **Status:** Aprobado
> **Depends on:** SPEC 03, SPEC 04, SPEC 06
> **Date:** 2026-11-07
> **Objective:** Implementar el módulo `order` del monolito `api` (carrito, checkout con precio tomado de `catalog`, división en `SubOrder`, saga de estados por eventos en memoria, outbox transaccional y expiración de pedidos).

## Por qué existe este spec

`docs/reglas-de-negocio.md` ("Pedidos", "Saga de pedido" y "Garantías de entrega") fija las reglas, pero hoy `order` es un esqueleto con un endpoint de ejemplo. `catalog` ya espera `order.created`, `order.confirmed` y `order.cancelled`, y `payments` necesitará el monto y el estado del pedido.

Decisiones no obvias que este spec cierra:

- **El outbox es el único camino de emisión.** `order` nunca emite `order.*` directamente: guarda el evento en `outbox_events` dentro de la transacción del cambio de estado y un job lo publica en memoria.
- **Pago tardío.** Un `payment.approved` confirma el pedido mientras siga en `AWAITING_PAYMENT`, aunque `expiresAt` ya haya pasado. El job de expiración solo cancela con una actualización condicional sobre el estado, así que gana quien cambie primero el estado.
- **Reserva tardía.** Si `catalog` responde `stock.reserved` cuando el pedido ya está `CANCELLED` (por la expiración del `PENDING`), `catalog` quedaría con stock reservado sin liberar. `order` vuelve a emitir `order.cancelled` (con otro `eventId`) para que `catalog` libere.
- **Colección de idempotencia propia.** `catalog` ya es dueño de `processed_events`; `order` usa `order_processed_events` para no compartir colección.
- **Hueco con `catalog`: tienda del PROVEEDOR.** El spec 06 no expone en su API pública una consulta de la tienda por `ownerId`, y `order` no puede leer `stores`. Este spec autoriza al PROVEEDOR con el claim `user.storeId` (ver "Propiedad y visibilidad" y Riesgos).
- **Huecos de las reglas** que este spec fija y que `docs/reglas-de-negocio.md` debe recoger al implementar (último paso):
  - `stock.released`: las reglas dicen que `order` lo consume pero no para qué. Aquí solo se marca procesado y se registra en el log.
  - Pago tardío (arriba).
  - «Tras 3 fallos, DLQ» de las reglas depende del transporte, que no está decidido. Este spec no lo implementa; el outbox usa 5 intentos y estado `FAILED`.

## Alcance

**Dentro:**

- **Colecciones propias de `order`** (Mongoose, base `mini-croper`): `carts`, `cart_items`, `orders`, `sub_orders`, `order_items`, `outbox_events` y `order_processed_events`, con sus índices.
- **Carrito del `PRODUCTOR`** en Mongo, un carrito por usuario, sin TTL.
- **Checkout** (`POST /orders/checkout`, rol `PRODUCTOR`, header `Idempotency-Key`): precio y datos del ítem desde `catalog`, snapshot en `OrderItem`, un `SubOrder` por tienda, pedido en `PENDING` y `order.created` en el outbox.
- **Consulta de pedidos:** `PRODUCTOR` los suyos, `PROVEEDOR` los sub-pedidos pagados de su tienda, `ADMIN` todos en solo lectura.
- **Saga:** reacción a `stock.reserved`, `stock.rejected`, `stock.released`, `payment.approved` y `payment.declined`; emisión de `order.created`, `order.confirmed` y `order.cancelled`.
- **Outbox transaccional** con job cada 2 s, reintentos con backoff y estado `FAILED`.
- **Expiración:** job cada 10 s para `AWAITING_PAYMENT` vencidos y para `PENDING` sin respuesta de `catalog` en 5 min.
- **Idempotencia de consumidores** con `order_processed_events`.
- **API pública de `index.ts`:** `OrderQueryService.getOrderForPayment`, eventos y tipos.
- **Dependencia nueva:** `@nestjs/schedule` (jobs con `@Interval`).
- **Validación y límites:** DTO `z.strictObject`, `StandardSchemaValidationPipe` global y rate limit global de 100 req/min por IP.
- **Documentación:** actualizar `docs/reglas-de-negocio.md` y `CLAUDE.md`.

**Fuera de alcance (para specs futuros):**

- `payments` (pago, simulador, webhook, `PaymentAttempt`).
- El transporte de eventos hacia `notifications` (RabbitMQ u otro) y la DLQ.
- Logística y envíos.
- Cotizaciones: los productos `requiresQuote` solo se excluyen del checkout.
- Cupones y descuentos.
- Múltiples monedas: solo COP.
- Cancelación manual de pedidos (por PRODUCTOR o ADMIN).
- Reembolsos y gestión de pagos huérfanos.
- Reproceso manual de eventos `FAILED` del outbox.
- Limpieza (TTL) de `outbox_events` y de `order_processed_events`.

## Modelo de datos

Colecciones propias de `order`. Ningún otro módulo las lee directamente. Los precios son enteros en COP, sin decimales. Los identificadores de código no llevan tildes.

```ts
// schemas/cart.schema.ts → colección `carts`
type Cart = {
  _id: ObjectId;
  buyerId: ObjectId; // User PRODUCTOR; índice único
  createdAt: Date;
  updatedAt: Date;
};

// schemas/cart-item.schema.ts → colección `cart_items`
type CartItem = {
  _id: ObjectId;
  cartId: ObjectId;
  variantId: ObjectId; // solo referencia; sin precio ni nombre
  cantidad: number; // entero 1..1000
  createdAt: Date;
  updatedAt: Date;
};

// schemas/order.schema.ts → colección `orders`
type Order = {
  _id: ObjectId;
  buyerId: ObjectId;
  total: number; // suma de los subtotales de sus SubOrder
  moneda: 'COP';
  status: 'PENDING' | 'AWAITING_PAYMENT' | 'CONFIRMED' | 'CANCELLED';
  expiresAt?: Date; // se fija al pasar a AWAITING_PAYMENT: ahora + 15 min
  idempotencyKey: string; // header Idempotency-Key
  cancelReason?: 'STOCK_REJECTED' | 'EXPIRED' | 'STOCK_TIMEOUT';
  createdAt: Date; // inicio de la espera de respuesta de catalog
  updatedAt: Date;
};

// schemas/sub-order.schema.ts → colección `sub_orders`
type SubOrder = {
  _id: ObjectId;
  orderId: ObjectId;
  storeId: ObjectId;
  subtotal: number;
  createdAt: Date;
};

// schemas/order-item.schema.ts → colección `order_items` (snapshot)
type OrderItem = {
  _id: ObjectId;
  orderId: ObjectId;
  subOrderId: ObjectId;
  variantId: ObjectId;
  productId: ObjectId;
  nombreProducto: string;
  presentacion: string;
  unidad: string;
  precioUnitario: number; // precioVigente de catalog en el checkout
  cantidad: number;
  subtotal: number; // precioUnitario * cantidad
};

// schemas/outbox-event.schema.ts → colección `outbox_events`
type OutboxEvent = {
  _id: ObjectId;
  eventId: string; // uuid v4; índice único
  type: 'order.created' | 'order.confirmed' | 'order.cancelled';
  correlationId: string; // id del pedido
  payload: Record<string, unknown>;
  occurredAt: Date;
  status: 'PENDING' | 'PUBLISHED' | 'FAILED';
  attempts: number; // default 0
  nextAttemptAt: Date; // default ahora
  lockedUntil?: Date; // reclamo del job
  publishedAt?: Date;
  lastError?: string; // sin datos personales
};

// schemas/processed-event.schema.ts → colección `order_processed_events`
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
| `carts` | `{ buyerId: 1 }` único |
| `cart_items` | `{ cartId: 1, variantId: 1 }` único |
| `orders` | `{ buyerId: 1, idempotencyKey: 1 }` único; `{ buyerId: 1, createdAt: -1 }`; `{ status: 1, expiresAt: 1 }`; `{ status: 1, createdAt: 1 }` |
| `sub_orders` | `{ orderId: 1, storeId: 1 }` único; `{ storeId: 1, createdAt: -1 }` |
| `order_items` | `{ orderId: 1 }` |
| `outbox_events` | `{ eventId: 1 }` único; `{ status: 1, nextAttemptAt: 1 }` |
| `order_processed_events` | `{ eventId: 1 }` único |

Un error de clave duplicada (código 11000) se traduce a `409`, salvo en el checkout con `Idempotency-Key` repetida, que devuelve el pedido existente.

### Estados y transiciones

```text
PENDING → AWAITING_PAYMENT → CONFIRMED
   │              │
   └──────────────┴──────→ CANCELLED
```

| Transición | Disparador | Condición de la actualización | Evento de outbox |
| --- | --- | --- | --- |
| (nuevo) → `PENDING` | `POST /orders/checkout` | — | `order.created` |
| `PENDING` → `AWAITING_PAYMENT` | `stock.reserved` | `{ status: 'PENDING' }`; fija `expiresAt = ahora + 15 min` | — |
| `PENDING` → `CANCELLED` | `stock.rejected` | `{ status: 'PENDING' }`; `cancelReason = 'STOCK_REJECTED'` | `order.cancelled` |
| `PENDING` → `CANCELLED` | job de expiración (5 min sin respuesta de `catalog`) | `{ status: 'PENDING', createdAt ≤ ahora − 5 min }`; `cancelReason = 'STOCK_TIMEOUT'` | `order.cancelled` |
| `AWAITING_PAYMENT` → `CONFIRMED` | `payment.approved` | `{ status: 'AWAITING_PAYMENT' }` (no mira `expiresAt`) | `order.confirmed` |
| `AWAITING_PAYMENT` → `CANCELLED` | job de expiración | `{ status: 'AWAITING_PAYMENT', expiresAt ≤ ahora }`; `cancelReason = 'EXPIRED'` | `order.cancelled` |

`CONFIRMED` y `CANCELLED` son finales. `payment.declined` no cambia el estado. No hay cancelación manual. La regla pura de transiciones vive en `policies/order-state.policy.ts`.

Cada transición hace, en una transacción de Mongo (`connection.startSession()`): la actualización condicional del pedido, el insert en `outbox_events` (si corresponde) y el insert del `eventId` consumido en `order_processed_events`. Si la actualización condicional no modifica ningún documento, la transacción se aborta y no se escribe el outbox.

### Eventos

Se usa el sobre `DomainEvent` que definió el spec 06 (`{ eventId, type, occurredAt, correlationId, payload }`, con el id del pedido como `correlationId`). `order` lo importa desde `modules/catalog/index.js`.

Nombres y payloads en `events/order.events.ts`:

```ts
export const OrderEvents = {
  OrderCreated: 'order.created',
  OrderConfirmed: 'order.confirmed',
  OrderCancelled: 'order.cancelled',
} as const;

// Eventos que order consume
export const ConsumedEvents = {
  PaymentApproved: 'payment.approved',
  PaymentDeclined: 'payment.declined',
} as const; // stock.* se importan de CatalogEvents (modules/catalog/index.js)

type OrderCreatedPayload = {
  orderId: string;
  items: { variantId: string; cantidad: number }[]; // contrato mínimo del spec 06
  buyerId: string; // campos añadidos, ninguno del spec 06 se quita
  total: number;
};
type OrderConfirmedPayload = { orderId: string; buyerId: string; total: number };
type OrderCancelledPayload = {
  orderId: string;
  buyerId: string;
  motivo: 'STOCK_REJECTED' | 'EXPIRED' | 'STOCK_TIMEOUT' | 'LATE_RESERVATION';
};

// Los emite `payments` (spec futuro); este spec fija lo que order necesita
type PaymentApprovedPayload = { orderId: string; paymentId: string; monto: number };
type PaymentDeclinedPayload = { orderId: string; paymentId: string; motivo: string };
```

`OrderCreatedPayload`, `OrderConfirmedPayload` y `OrderCancelledPayload` del spec 06 solo exigen `orderId` (y `items` en `order.created`); los campos añadidos aquí son compatibles.

### Consumidores (saga)

`services/order-saga.service.ts` escucha con `@OnEvent`. Todo consumidor primero mira `order_processed_events`: si el `eventId` ya está, no hace nada.

| Evento | Comportamiento |
| --- | --- |
| `stock.reserved` | `PENDING` → `AWAITING_PAYMENT` con `expiresAt` a 15 min. Si el pedido está `CANCELLED`, escribe `order.cancelled` con `motivo: 'LATE_RESERVATION'` en el outbox para que `catalog` libere. En cualquier otro estado, solo marca procesado. |
| `stock.rejected` | `PENDING` → `CANCELLED` y `order.cancelled` en el outbox. Si el estado no es `PENDING`, solo marca procesado. |
| `stock.released` | Solo marca procesado y deja un log. No cambia ningún estado. |
| `payment.approved` | `AWAITING_PAYMENT` → `CONFIRMED` y `order.confirmed`. En cualquier otro estado: se ignora, se marca procesado y se deja un log `warn` con el `orderId`. El pedido no se reabre; no hay reembolsos. |
| `payment.declined` | No cambia el estado. Marca procesado y deja un log. El pedido sigue en `AWAITING_PAYMENT` mientras no venza. |

### Outbox

- `services/outbox.service.ts` ofrece `add(session, type, orderId, payload)`: inserta el evento `PENDING` con `eventId` uuid v4 dentro de la sesión recibida. Es la única forma en que `order` produce eventos `order.*`.
- `services/outbox-publisher.service.ts` corre con `@Interval(2000)`. En cada ciclo reclama un evento a la vez con `findOneAndUpdate` atómico:

```ts
OutboxEvent.findOneAndUpdate(
  { status: 'PENDING', nextAttemptAt: { $lte: ahora }, $or: [{ lockedUntil: { $exists: false } }, { lockedUntil: { $lte: ahora } }] },
  { $set: { lockedUntil: ahora + 30_000 } },
  { sort: { occurredAt: 1 } },
);
```

- Publica con `EventEmitter2.emitAsync(type, envelope)`, donde `envelope` es el `DomainEvent` completo. Los listeners que fallan hacen que `emitAsync` rechace y cuente como fallo.
- Éxito: `status = 'PUBLISHED'`, `publishedAt = ahora`.
- Fallo: `attempts += 1`, `lastError` con el mensaje (sin payload), `lockedUntil` se limpia y `nextAttemptAt = ahora + min(2 s × 2^attempts, 60 s)` (`policies/outbox-backoff.policy.ts`). Al llegar a 5 intentos fallidos pasa a `FAILED` y no se reintenta; queda para revisión manual.
- Si el proceso cae tras publicar y antes de marcar `PUBLISHED`, el evento se vuelve a publicar al vencer `lockedUntil`. Es entrega al menos una vez: los consumidores (`catalog` incluido) son idempotentes por `eventId`.
- Un ciclo no se solapa con el anterior (bandera en memoria; una sola instancia).

### Expiración

`services/order-expiration.service.ts` corre con `@Interval(10000)`. Cada ciclo busca candidatos (hasta 100) y procesa cada pedido en su propia transacción:

1. `AWAITING_PAYMENT` con `expiresAt ≤ ahora` → `CANCELLED` (`EXPIRED`).
2. `PENDING` con `createdAt ≤ ahora − 5 min` → `CANCELLED` (`STOCK_TIMEOUT`).

La actualización es condicional (ver "Estados y transiciones") y escribe `order.cancelled` en el outbox en la misma transacción. Si la actualización no modifica nada (un `payment.approved` o `stock.*` ganó la carrera), la transacción se aborta y no se emite nada. `catalog` solo libera una reserva `RESERVED`, así que cancelar un pedido sin reserva no libera nada. Si la reserva llega después, la regla de `stock.reserved` tardío la libera.

### Propiedad y visibilidad

| Rol | Puede | No puede |
| --- | --- | --- |
| `PRODUCTOR` | Su carrito, `POST /orders/checkout`, `GET /orders` y `GET /orders/:id` de **sus** pedidos | Ver pedidos ajenos (`404`) |
| `PROVEEDOR` | `GET /orders/provider/sub-orders` y `/:id` de su tienda, solo si el pedido está `CONFIRMED` | Ver sub-pedidos ajenos o sin pagar (`404`); ver el pedido completo |
| `ADMIN` | `GET /orders/admin` y `/:id` de todos los pedidos, solo lectura | Carritos, checkout, modificar o cancelar pedidos (`403` por rol en lo demás) |

- La tienda del PROVEEDOR sale del claim `user.storeId` de `@CurrentUser()`. Sin ese claim, el listado devuelve vacío y el detalle `404`. Decisión forzada por el spec 06 (ver Riesgos).
- La vista del PROVEEDOR devuelve solo el `SubOrder` con sus `OrderItem`, el `orderId`, el estado y la fecha. No incluye `buyerId`, ni `total`, ni las demás tiendas.
- El `PRODUCTOR` ve el pedido con sus `SubOrder` y `OrderItem` (snapshot).

### Endpoints

Todos los DTO son `z.strictObject`; los ids de ruta se validan como ObjectId de 24 caracteres hexadecimales. Ningún endpoint es `@Public()`.

| Método y ruta | Rol | Notas |
| --- | --- | --- |
| `GET /orders/cart` | PRODUCTOR | Ítems con `precioVigente`, `disponible` y `apta` actuales (vía `getCheckoutVariants`), más `total` informativo. Carrito inexistente: lista vacía. |
| `PUT /orders/cart/items/:variantId` | PRODUCTOR | Body `{ cantidad }` (entero 1..1000, valor absoluto). Crea el carrito si no existe. `400` si la variante no existe o no es `apta`. `400` si el carrito ya tiene 50 líneas y la variante es nueva. |
| `DELETE /orders/cart/items/:variantId` | PRODUCTOR | Idempotente: `204` exista o no. |
| `DELETE /orders/cart` | PRODUCTOR | Vacía el carrito. `204`. |
| `POST /orders/checkout` | PRODUCTOR | Header `Idempotency-Key` obligatorio (string de 8 a 100 caracteres); sin body. `201` con el pedido en `PENDING`. Repetir la misma clave devuelve el mismo pedido con `200`. Carrito vacío, variante inexistente o no `apta` (incluye `requiresQuote`): `400` con el detalle de las líneas inválidas. |
| `GET /orders` | PRODUCTOR | Query `page` (≥ 1), `limit` (defecto 20, máx. 100), `status?`; orden `createdAt` descendente. |
| `GET /orders/:id` | PRODUCTOR | Pedido propio con sub-pedidos e ítems; ajeno: `404`. |
| `GET /orders/provider/sub-orders` | PROVEEDOR | Misma paginación. Solo pedidos `CONFIRMED` de su tienda. |
| `GET /orders/provider/sub-orders/:id` | PROVEEDOR | Ajeno o sin pagar: `404`. |
| `GET /orders/admin` | ADMIN | Misma paginación; filtros `status?` y `buyerId?`. |
| `GET /orders/admin/:id` | ADMIN | Detalle completo. |

La respuesta paginada es `{ data, page, limit, total }`. Las rutas fijas (`cart`, `checkout`, `provider`, `admin`) se declaran antes de `:id` para que no se confundan con un id.

### Checkout

1. Valida el header y lee el carrito del PRODUCTOR. Si ya existe un pedido con `(buyerId, idempotencyKey)`, lo devuelve con `200`.
2. Llama a `CatalogQueryService.getCheckoutVariants(variantIds)`. Toda variante ausente o con `apta = false` se reporta como línea inválida (`400`).
3. Calcula `precioUnitario = precioVigente`, `subtotal` por ítem y por tienda, y `total` (`policies/order-totals.policy.ts`, funciones puras). El cliente nunca envía precios.
4. En una transacción: inserta `Order` (`PENDING`), un `SubOrder` por tienda (siempre, aunque sea una sola), los `OrderItem` con su snapshot, el evento `order.created` en el outbox y borra los `cart_items`.
5. Si el insert del pedido falla con 11000 por la clave de idempotencia (doble clic simultáneo), devuelve el pedido existente con `200`.
6. No valida stock: lo hace `catalog` al recibir `order.created` y responde con `stock.reserved` o `stock.rejected`.

### API pública de `index.ts`

```ts
export { OrderModule } from './order.module.js';
export { OrderQueryService } from './services/order-query.service.js';
export type { OrderForPayment } from './services/order-query.service.js';
export {
  OrderEvents,
  ConsumedEvents,
  type OrderCreatedPayload,
  type OrderConfirmedPayload,
  type OrderCancelledPayload,
  type PaymentApprovedPayload,
  type PaymentDeclinedPayload,
} from './events/order.events.js';
export type { DomainEvent } from '../catalog/index.js';
```

Propósito de `OrderQueryService` (solo la interfaz; lo consumirá `payments` para validar el pago, porque el monto sale siempre del pedido):

```ts
type OrderForPayment = {
  orderId: string;
  buyerId: string;
  total: number; // monto a cobrar
  moneda: 'COP';
  status: 'PENDING' | 'AWAITING_PAYMENT' | 'CONFIRMED' | 'CANCELLED';
  expiresAt: Date | null;
};

getOrderForPayment(orderId: string, buyerId: string): Promise<OrderForPayment | null>;
```

Devuelve `null` si el pedido no existe o no pertenece a `buyerId`. `payments` debe tratar `null` como `404` y cualquier `status` distinto de `AWAITING_PAYMENT` como error de pago. `payments` emite `payment.approved` y `payment.declined` con los payloads de arriba; este spec los fija y el spec de `payments` los respeta o ajusta.

### Estructura de archivos

```text
apps/api/src/modules/order/
  index.ts
  order.module.ts
  controllers/
    cart.controller.ts                # /orders/cart
    orders.controller.ts              # checkout y pedidos del PRODUCTOR
    provider-orders.controller.ts     # sub-pedidos del PROVEEDOR
    orders-admin.controller.ts        # lectura del ADMIN
  services/
    cart.service.ts
    checkout.service.ts
    orders.service.ts                 # consultas por rol
    order-query.service.ts            # API pública para payments
    order-saga.service.ts             # @OnEvent, transiciones, idempotencia
    outbox.service.ts
    outbox-publisher.service.ts       # job cada 2 s
    order-expiration.service.ts       # job cada 10 s
  dto/
    cart.dto.ts
    checkout.dto.ts
    order-query.dto.ts
  schemas/
    cart.schema.ts
    cart-item.schema.ts
    order.schema.ts
    sub-order.schema.ts
    order-item.schema.ts
    outbox-event.schema.ts
    processed-event.schema.ts
  events/
    order.events.ts
  policies/
    order-state.policy.ts
    order-totals.policy.ts
    outbox-backoff.policy.ts
  tests/                              # todos los *.spec.ts, planos
apps/api/test/
  order.e2e-spec.ts
```

`order.controller.ts`, `order.service.ts` y `order.controller.spec.ts` del esqueleto se sustituyen por los archivos de arriba, con `git mv` donde corresponda. Cada carpeta se crea solo cuando tiene contenido.

## Plan de implementación

Cada paso deja el sistema compilando y con `npm test` en verde, es commiteable por separado y no supera 30–50 líneas de código de producción (sin contar specs).

1. **Contratos y reglas puras.** Crear `events/order.events.ts`, `policies/order-state.policy.ts` (transiciones permitidas), `policies/order-totals.policy.ts` y `policies/outbox-backoff.policy.ts`. Specs: transiciones válidas e inválidas, totales por tienda, backoff con tope de 60 s.
2. **Schemas e índices.** Crear los siete schemas con sus índices y registrarlos en `OrderModule` con `MongooseModule.forFeature`. Spec de defaults e índices (patrón de `auth/tests/schemas.spec.ts`).
3. **DTO.** Crear los tres archivos de `dto/`: ObjectId, `cantidad` 1..1000, paginación (`limit` máx. 100), `status` válido, header `Idempotency-Key`. Spec: rechaza propiedades de más, `{"$ne": null}`, `limit` 101 y `cantidad` 0 o 1001.
4. **Carrito: escritura.** `CartService.setItem`, `removeItem` y `clear` con `PUT` y `DELETE` de `cart.controller.ts` (`@Roles(Role.PRODUCTOR)`). `setItem` valida con `getCheckoutVariants` que la variante exista y sea `apta`, y el máximo de 50 líneas. Specs de cada rama.
5. **Carrito: lectura.** `CartService.get` y `GET /orders/cart` con precio vigente, `disponible` y `apta` actuales. Spec: carrito vacío, oferta, variante que dejó de ser apta.
6. **Outbox: alta.** `OutboxService.add(session, ...)`. Spec: inserta `PENDING` con `eventId` uuid, `attempts: 0` y `nextAttemptAt`.
7. **Checkout.** `CheckoutService.checkout` y `POST /orders/checkout` (`@Roles(Role.PRODUCTOR)`, `Idempotency-Key`): validación contra catálogo, snapshot, un `SubOrder` por tienda, `order.created` en el outbox y vaciado del carrito, todo en una transacción. Specs: precio de catálogo (no del cliente), `requiresQuote` rechazado con detalle, carrito vacío, un solo `SubOrder` con una tienda, clave repetida devuelve `200` con el mismo pedido.
8. **Publicador del outbox.** Añadir `@nestjs/schedule`, registrar `ScheduleModule.forRoot()` en `OrderModule` e implementar `OutboxPublisherService` con `@Interval(2000)`: reclamo atómico, `emitAsync`, `PUBLISHED`, reintentos con backoff y `FAILED` tras 5 intentos. Specs con `EventEmitter2` simulado: éxito, fallo reintenta, quinto fallo `FAILED`, evento bloqueado no se reclama.
9. **Saga: reserva y rechazo.** `OrderSagaService` con `@OnEvent('stock.reserved')` y `@OnEvent('stock.rejected')`: transacción, actualización condicional, outbox e idempotencia. Incluye la reserva tardía sobre `CANCELLED`. Specs: `AWAITING_PAYMENT` con `expiresAt` a 15 min, `CANCELLED` con `order.cancelled`, `eventId` repetido, `stock.reserved` tardío re-emite `order.cancelled`.
10. **Saga: pago y liberación.** `@OnEvent` de `payment.approved`, `payment.declined` y `stock.released`. Specs: `CONFIRMED` con `order.confirmed`, `payment.approved` en `CANCELLED` ignorado con `warn`, `payment.declined` sin cambio de estado, `stock.released` solo marca procesado.
11. **Expiración.** `OrderExpirationService` con `@Interval(10000)`: `AWAITING_PAYMENT` vencido y `PENDING` de más de 5 min, actualización condicional y outbox por pedido. Specs: vence y cancela, `payment.approved` ya aplicado no se cancela, `PENDING` reciente no se toca.
12. **Consulta del PRODUCTOR y API pública.** `OrdersService.listMine` y `getMine`, `GET /orders` y `GET /orders/:id`; `OrderQueryService.getOrderForPayment` y `index.ts` completo. Specs: ajeno `404`, paginación, `null` si no existe o no es del comprador.
13. **Consulta del PROVEEDOR y del ADMIN.** `provider-orders.controller.ts` y `orders-admin.controller.ts` con sus servicios de lectura. Specs: PROVEEDOR solo `CONFIRMED` y de su `storeId`, sin `buyerId` en la respuesta; ADMIN con filtros; `403` cruzados por rol.
14. **E2E.** Crear `apps/api/test/order.e2e-spec.ts` contra MongoDB: carrito, checkout, `stock.reserved` real de `catalog`, `payment.approved` emitido con `EventEmitter2`, confirmación y liberación de stock; expiración con reloj acelerado; visibilidad por rol.
15. **Documentación.** Actualizar `docs/reglas-de-negocio.md` (`stock.released`, pago tardío, cancelación de `PENDING` sin respuesta, `Idempotency-Key` en checkout, estados del outbox y que la DLQ depende del transporte, fecha e historial) y `CLAUDE.md` (lo que exporta `order`, `@nestjs/schedule`).

## Criterios de aceptación

- [ ] Todos los endpoints de `/orders` responden 401 sin token.
- [ ] `PRODUCTOR` recibe 403 en `/orders/provider/*` y `/orders/admin*`; `PROVEEDOR` y `ADMIN` reciben 403 en carrito y checkout.
- [ ] `PUT /orders/cart/items/:variantId` con la misma `cantidad` dos veces deja una sola línea con esa cantidad.
- [ ] Agregar al carrito una variante inexistente, inactiva o `requiresQuote` devuelve 400; la línea 51 devuelve 400.
- [ ] `cantidad` 0 y 1001 devuelven 400; una propiedad de más o `{"$ne": null}` devuelve 400 sin consultar Mongo.
- [ ] `GET /orders/cart` devuelve `precioVigente` igual al de `catalog` y `apta` actual.
- [ ] `POST /orders/checkout` sin `Idempotency-Key` devuelve 400.
- [ ] `POST /orders/checkout` devuelve 201 con `status: PENDING`, `total` igual a la suma de `precioVigente × cantidad` de catálogo y `moneda: COP`.
- [ ] Un precio enviado por el cliente se ignora o devuelve 400; el `OrderItem` guarda el de `catalog`.
- [ ] Un carrito con un producto `requiresQuote` devuelve 400 con el detalle de la línea y no crea pedido.
- [ ] Un carrito vacío devuelve 400.
- [ ] Un checkout con ítems de dos tiendas crea dos `SubOrder`; con una sola tienda crea uno.
- [ ] Cambiar el precio o el nombre en `catalog` después del checkout no cambia el `OrderItem` guardado.
- [ ] El checkout vacía el carrito y deja `order.created` en `outbox_events` en la misma transacción; si algún insert falla, no queda pedido, ni evento, ni carrito vaciado.
- [ ] Repetir `Idempotency-Key` devuelve 200 con el mismo `orderId` y no crea otro pedido ni otro `order.created`.
- [ ] El payload de `order.created` incluye `orderId` e `items: [{ variantId, cantidad }]`.
- [ ] `order` no importa ni consulta `products`, `product_variants` ni `stores`; consume `catalog` solo con `modules/catalog/index.js`.
- [ ] `stock.reserved` pasa `PENDING` a `AWAITING_PAYMENT` con `expiresAt` 15 min después.
- [ ] `stock.rejected` pasa `PENDING` a `CANCELLED` y deja `order.cancelled` en el outbox.
- [ ] `stock.reserved` sobre un pedido `CANCELLED` deja un `order.cancelled` con `motivo: LATE_RESERVATION`.
- [ ] `payment.approved` sobre `AWAITING_PAYMENT` deja el pedido en `CONFIRMED` y escribe `order.confirmed`, incluso con `expiresAt` pasado.
- [ ] `payment.approved` sobre un pedido en otro estado no cambia nada, marca el evento procesado y registra un `warn`.
- [ ] `payment.declined` no cambia el estado del pedido.
- [ ] `stock.released` solo marca el evento procesado y no cambia estados.
- [ ] Reenviar el mismo `eventId` a cualquier consumidor no repite la transición ni el outbox.
- [ ] Ninguna transición ocurre fuera de las de la tabla; `CONFIRMED` y `CANCELLED` no cambian nunca.
- [ ] Ningún servicio de `order` llama a `EventEmitter2.emit` para `order.*` fuera de `OutboxPublisherService`.
- [ ] El job del outbox corre cada 2 s, publica con `emitAsync`, marca `PUBLISHED` y guarda `publishedAt`.
- [ ] Un fallo de publicación suma `attempts`, guarda `lastError`, aplica backoff con `nextAttemptAt` y, al quinto fallo, deja el evento en `FAILED` sin más reintentos.
- [ ] Un evento reclamado con `lockedUntil` vigente no lo publica un segundo ciclo.
- [ ] El job de expiración corre cada 10 s y cancela con `EXPIRED` los `AWAITING_PAYMENT` con `expiresAt` vencido, escribiendo `order.cancelled`.
- [ ] El job cancela con `STOCK_TIMEOUT` los `PENDING` con más de 5 min.
- [ ] Un pedido que pasa a `CONFIRMED` entre la lectura del job y su actualización no se cancela y no genera `order.cancelled`.
- [ ] Tras `order.cancelled`, `catalog` libera el stock (e2e con `catalog` real).
- [ ] `GET /orders` devuelve solo pedidos del PRODUCTOR autenticado, con `limit` 20 por defecto; `limit=101` devuelve 400.
- [ ] `GET /orders/:id` de un pedido ajeno devuelve 404.
- [ ] `GET /orders/provider/sub-orders` devuelve solo `SubOrder` de su `storeId` con el pedido `CONFIRMED`; uno sin pagar o de otra tienda devuelve 404 en el detalle.
- [ ] La vista del PROVEEDOR no contiene `buyerId`, `total` ni datos de otras tiendas.
- [ ] `GET /orders/admin` y `/:id` listan todos los pedidos con filtros `status` y `buyerId`; `ADMIN` no tiene ningún endpoint que modifique pedidos.
- [ ] `OrderQueryService.getOrderForPayment` devuelve `total`, `moneda`, `status` y `expiresAt`, y `null` si el pedido no existe o es de otro comprador.
- [ ] `order` no implementa `payments`, el transporte hacia `notifications` ni cancelación manual.
- [ ] `order` cumple la estructura de módulo de `CLAUDE.md`: en la raíz solo `index.ts` y `order.module.ts`; carpetas de la lista estándar y sin vacías; todos los `*.spec.ts` planos en `tests/`; ningún módulo importa archivos internos de `order`.
- [ ] `@nestjs/schedule` figura en `package.json`.
- [ ] `docs/reglas-de-negocio.md` documenta las reglas nuevas y tiene entrada nueva en el historial; `CLAUDE.md` refleja lo que exporta `order`.
- [ ] `npm run build:all`, `npm run lint`, `npm test` y `npm run test:e2e` terminan sin errores.

## Decisiones

- **Sí:** carrito en Mongo (`carts` y `cart_items`), un carrito por PRODUCTOR con índice único en `buyerId`, sin TTL. Las reglas listan `Cart` y `CartItem` y el carrito sobrevive a reinicios.
- **No:** carrito en memoria. Se perdería al reiniciar.
- **Sí:** `CartItem` guarda solo `variantId` y `cantidad`; el precio se consulta a `catalog` al leer el carrito. El precio nunca se guarda fuera del checkout.
- **Sí:** `PUT` con `cantidad` absoluta, no relativa. Un reintento no duplica el efecto, igual que el stock del spec 06.
- **Sí:** al agregar solo se valida que la variante exista y sea `apta`; el stock solo se valida en el checkout vía `stock.rejected`. La reserva ya es la fuente de verdad.
- **Sí:** siempre un `SubOrder` por tienda, aunque sea una sola. Modelo uniforme para la vista del PROVEEDOR.
- **Sí:** snapshot en `OrderItem` (`nombreProducto`, `presentacion`, `unidad`, `precioUnitario`) y `Order.total` como suma, con `moneda = 'COP'`. El pedido no cambia si el catálogo cambia.
- **Sí:** límites de 50 líneas y `cantidad` 1..1000; carrito vacío o ítem no apto devuelve 400 con el detalle. Evita pedidos y payloads enormes.
- **Sí:** `Idempotency-Key` obligatorio en el checkout, único por `(buyerId, idempotencyKey)`; un doble clic devuelve el mismo pedido con 200. Las reglas lo exigen en pagos y el mismo riesgo aplica aquí.
- **Sí:** `PRODUCTOR` lista sus pedidos con `page`, `limit` (20 por defecto, 100 máximo), `status?` y orden `createdAt` descendente. Mismo patrón que `auth` y `catalog`.
- **Sí:** `PROVEEDOR` ve solo sub-pedidos de su tienda con el pedido `CONFIRMED`; el ajeno o sin pagar responde 404. Es lo que dicen las reglas y no revela su existencia.
- **Sí:** `ADMIN` consulta todos los pedidos en solo lectura (`status?`, `buyerId?`); no ve carritos ni modifica nada. Es el mínimo para supervisar sin ampliar permisos.
- **No:** cancelación manual. Solo se cancela por `stock.rejected` o por expiración; las reglas no la definen.
- **Sí:** `payment.approved` en un estado distinto de `AWAITING_PAYMENT` se ignora, se marca procesado y se deja un `warn`. Sin pagos huérfanos ni reembolsos, que están fuera de alcance.
- **Sí:** un `payment.approved` confirma con `expiresAt` pasado mientras el estado siga `AWAITING_PAYMENT`. El pago ya se cobró; el job solo cancela con actualización condicional.
- **Sí:** `stock.reserved` sobre un pedido `CANCELLED` re-emite `order.cancelled` (`LATE_RESERVATION`). Evita stock reservado sin liberar por la cancelación `STOCK_TIMEOUT`.
- **Sí:** el job de expiración también cancela `PENDING` con más de 5 min. Cubre el hueco de entrega que el spec 06 dejó aceptado como riesgo.
- **Sí:** `@nestjs/schedule` con `@Interval`: outbox cada 2 s y expiración cada 10 s. Dependencia nueva, declarada en este spec.
- **No:** `setInterval` manual. Mezcla ciclo de vida y lógica, y es más difícil de probar.
- **Sí:** outbox con estados `PENDING`, `PUBLISHED` y `FAILED`, `attempts`, backoff con `nextAttemptAt`, 5 intentos, reclamo atómico con `lockedUntil` y sin DLQ. La DLQ depende del transporte, que no está decidido.
- **Sí:** el outbox es el único camino de emisión de `order.created`, `order.confirmed` y `order.cancelled`. Ningún servicio emite directo.
- **No:** emitir directamente tras el commit. Se perdería el evento ante una caída y duplicaría la emisión.
- **Sí:** `stock.released` solo marca procesado y deja un log. El pedido ya está `CANCELLED`; las reglas no le dan otro efecto.
- **Sí:** colección propia `order_processed_events` con `eventId` único. `processed_events` es de `catalog`.
- **Sí:** `OrderQueryService.getOrderForPayment(orderId, buyerId)` devuelve `OrderForPayment | null`. El monto lo toma `payments` desde `order`, nunca del cliente.
- **Sí:** este spec fija los payloads de `payment.approved` (`{ orderId, paymentId, monto }`) y `payment.declined` (`{ orderId, paymentId, motivo }`). El spec de `payments` los respeta o ajusta.
- **Sí:** el payload de `order.created` suma `buyerId` y `total` al contrato del spec 06. Solo se añaden campos.
- **Sí:** la tienda del PROVEEDOR sale del claim `user.storeId`. El spec 06 es entrada cerrada y su API pública no expone la tienda por `ownerId`.
- **No:** que `order` lea `stores`. La colección es de `catalog`.
- **Sí:** rate limit global de 100 req/min, sin `@Throttle` propio. Las reglas no fijan uno para `/orders`.
- **Sí:** `docs/reglas-de-negocio.md` y `CLAUDE.md` se actualizan al implementar (paso 15), no al escribir este spec.

## Riesgos

| Riesgo | Mitigación |
| --- | --- |
| La decisión de resolver la tienda del PROVEEDOR por `ownerId` no es posible: `catalog` no la expone. Con el claim `storeId`, un PROVEEDOR que acaba de crear su tienda no ve sub-pedidos hasta renovar el token (hasta 15 min) | Efecto leve, porque aún no tiene pedidos pagados. Alternativa: que el usuario autorice añadir a `CatalogQueryService` una consulta de la tienda por `ownerId` (cambio en el spec 06). |
| `catalog` cae tras confirmar la reserva y antes de emitir `stock.reserved`: el pedido queda en `PENDING` | El job lo cancela a los 5 min (`STOCK_TIMEOUT`) y emite `order.cancelled`; `catalog` libera la reserva `RESERVED`. |
| `stock.reserved` llega después de la cancelación por `STOCK_TIMEOUT` | La reserva tardía re-emite `order.cancelled` (`LATE_RESERVATION`). |
| Publicación duplicada del outbox si el proceso cae tras publicar y antes de marcar `PUBLISHED` | Entrega al menos una vez; los consumidores son idempotentes por `eventId`. |
| Un evento `FAILED` queda sin publicar y el pedido sigue estancado | Fuera de alcance el reproceso; queda visible en `outbox_events` con `lastError`. Un spec posterior añade la herramienta. |
| Pago aprobado tras la cancelación por expiración (cobro sin pedido) | Aceptado: se ignora con `warn`; el reembolso queda fuera de alcance. |
| Dos jobs solapados o varias instancias publican el mismo evento | Reclamo atómico con `lockedUntil`; hoy hay una sola instancia. |
| `catalog` o `payments` lanzan una excepción al recibir un evento y bloquean al resto del lote | `emitAsync` rechaza solo para ese evento; cada evento se reintenta de forma independiente con backoff. |
| `order_processed_events` y `outbox_events` crecen sin límite | Aceptado en el alcance actual; un índice TTL puede añadirse después sin cambiar el contrato. |
| Dos peticiones simultáneas añaden la línea 51 al carrito | Aceptado: el límite es de protección, no una invariante de negocio. |
| Las transacciones fallan si MongoDB no corre como replica set | `docker-compose.yml` ya lo levanta como `rs0`; los e2e lo exigen. |
| ESM: imports relativos sin `.js` rompen el build | Seguir la convención del repo (`./archivo.js`). |

## Qué **no** está en este spec

- `payments` (pago, simulador, webhook, `PaymentAttempt`).
- El transporte de eventos hacia `notifications` y la DLQ.
- Logística, cotizaciones, cupones y múltiples monedas.
- Cancelación manual de pedidos, reembolsos y pagos huérfanos.
- Reproceso manual de eventos `FAILED` y limpieza (TTL) de `outbox_events` y `order_processed_events`.

Cada uno de estos, si se aborda, va en su propio spec.

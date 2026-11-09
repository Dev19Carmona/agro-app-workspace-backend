# SPEC 11 — Notifications: lectura de avisos (API interna con token de servicio, módulo `notification-inbox` en `api` y estado de lectura)

> **Status:** Aprobado
> **Depends on:** SPEC 03, SPEC 04, SPEC 07, SPEC 09, SPEC 10
> **Date:** 2026-11-09
> **Objective:** Permitir que el PRODUCTOR y el PROVEEDOR lean sus avisos desde el frontend: `api` expone `GET /notifications`, el contador de no leídos y el marcado como leído, y obtiene los datos del servicio `notifications` por una API interna protegida con token de servicio.

## Por qué existe este spec

Los SPEC 09 y 10 dejan los avisos guardados en `mini-croper-notifications` (colección `notifications`), pero **ningún endpoint los expone**. El servicio `notifications` (puerto 3005) solo consume eventos y no es público; el monolito `api` (puerto 3000) es la única entrada pública y no puede leer esa base sin romper "cada app solo toca su base". `docs/reglas-de-negocio.md` ya anticipa el camino: endpoints `/internal/*` de `notifications` protegidos con token de servicio y no expuestos por `api`.

Decisiones no obvias que este spec cierra:

- **`api` expone la ruta pública y llama por HTTP a `notifications`.** Se compararon tres caminos: (a) `api` pública + `/internal/*` en `notifications`; (b) `api` lee directamente la base de `notifications`; (c) `notifications` pública con su propio JWT. Se elige (a): conserva la frontera de bases, deja a `api` como única entrada pública (un solo JWT, CORS y límite de peticiones) y no obliga a `notifications` a verificar tokens de usuario.
- **El actor lo arma `api` desde el token, nunca el cliente.** `api` valida el JWT y manda a `notifications` `userId` (del claim `sub`) y, para el PROVEEDOR, `storeId` (del claim `storeId`). El cliente no puede pedir avisos de otro porque ninguna ruta pública acepta un `userId` ni un `storeId`.
- **La propiedad se comprueba en el filtro de Mongo, no después.** Listar, contar y marcar leído usan el mismo filtro del actor: un `id` ajeno no coincide y da **404** (no 403), para no revelar que existe.
- **Token de servicio en un header propio** (`X-Service-Token`), no en `Authorization`, para no confundirlo con el JWT de usuario. Variable obligatoria en las dos apps, sin valor por defecto.
- **Paginación por cursor, no por `page/total`.** Los avisos son una bandeja que crece por arriba mientras el usuario la mira: con `page/limit` un aviso nuevo desplaza los resultados. Esto se aparta a propósito del `{ data, page, limit, total }` de `order`.
- **El estado de lectura vive en `Notification.readAt`.** Es un campo nuevo y opcional: los avisos existentes quedan como "no leídos".
- **El ADMIN no ve avisos (403).** Hoy ningún evento le envía avisos; si más adelante los recibe, es un cambio de este módulo.
- **La respuesta pública se arma campo por campo.** No sale `eventId`, `eventType`, `correlationId`, `destinatarioId` ni `canal`.
- **`notifications` caída no tumba a `api`.** La llamada tiene tiempo límite y, si falla, solo responde 503 en las rutas de avisos.

## Alcance

**Dentro:**

- **`notifications`:** API interna `GET /internal/notifications`, `GET /internal/notifications/unread-count`, `PATCH /internal/notifications/:id/read` y `POST /internal/notifications/read-all`, con guard de token de servicio; campo `readAt` e índices; endurecimiento HTTP (`applySecurity`, pipe de schemas).
- **`api`:** módulo `notification-inbox` con `GET /notifications`, `GET /notifications/unread-count`, `PATCH /notifications/:id/read` y `POST /notifications/read-all`; cliente HTTP tras un token de inyección; manejo de errores y tiempo límite.
- **Entorno:** `INTERNAL_SERVICE_TOKEN` (obligatoria en `api` y `notifications`) y `NOTIFICATIONS_INTERNAL_URL` (opcional en `api`).
- **Pruebas:** unitarias por pieza y e2e contra MongoDB y RabbitMQ reales, incluido `notifications` caída.
- **Documentación:** `docs/reglas-de-negocio.md` y `CLAUDE.md`.

**Fuera de alcance (para specs futuros):**

- Push, WebSocket o SSE (el frontend sondea).
- Email o SMS reales.
- Preferencias de notificación por usuario.
- Borrar o archivar avisos y TTL de la colección.
- Reproceso de la DLQ y de eventos `FAILED` del puente.
- Avisos al ADMIN.
- Plantillas editables y localización.
- Rotación del token de servicio, tokens distintos por servicio y TLS entre `api` y `notifications`.
- Reintentos y *circuit breaker* de la llamada a `notifications`.
- Cuentas con más de una tienda o más de una persona por tienda (hoy hay una tienda por PROVEEDOR).

## Contrato público (`api`)

Todas las rutas son privadas (JWT) con `@Roles(Role.PRODUCTOR, Role.PROVEEDOR)`; el ADMIN recibe 403. El actor sale siempre del token.

| Método y ruta | Descripción | Respuesta |
| --- | --- | --- |
| `GET /notifications?limit&cursor` | Avisos visibles, del más nuevo al más viejo | `200 { data: NotificationView[], nextCursor: string \| null }` |
| `GET /notifications/unread-count` | Cantidad de avisos sin leer | `200 { count: number }` |
| `POST /notifications/read-all` | Marca como leídos todos los visibles | `200 { updated: number }` |
| `PATCH /notifications/:id/read` | Marca uno como leído (idempotente) | `200 NotificationView`; ajeno o inexistente: `404` |

- **Visibilidad.** PRODUCTOR: sus avisos `USER`. PROVEEDOR: sus avisos `USER` y, si el token trae `storeId`, los `STORE` de esa tienda. Un PROVEEDOR sin `storeId` en el token solo ve los `USER`.
- **Query** (`z.strictObject`): `limit` entero de 1 a 50 (por defecto 20) y `cursor` ObjectId opcional. Cualquier otra propiedad da 400.
- **Params:** `:id` es un ObjectId (si no, 400, como en `order`).
- **Cursor.** Es el `id` del último aviso de la página. Se pide `limit + 1` documentos; si hay uno más, `nextCursor` es el `id` del último devuelto, y si no, `null`. Un `cursor` que no existe o no pertenece al actor no revela nada: simplemente la consulta `_id < cursor` devuelve lo que corresponda.
- **`read-all`** solo toca avisos del actor que siguen sin leer; llamarlo dos veces devuelve `updated: 0` la segunda.
- **`PATCH :id/read`** sobre un aviso ya leído lo devuelve sin cambiar `readAt`.

```ts
// Lo único que sale hacia el frontend.
type NotificationView = {
  id: string;
  plantilla: Plantilla;               // la lista del SPEC 10
  destinatarioTipo: 'USER' | 'STORE';
  titulo: string;                     // texto en español, listo para mostrar
  mensaje: string;
  orderId: string | null;             // solo en avisos de pagos y pedidos
  sentAt: string;                     // ISO 8601
  readAt: string | null;
};
```

`orderId` es el `correlationId` cuando `eventType` empieza por `order.` o `payment.`; en los avisos de cuenta (`user.registered`, `provider.*`) es `null`. `notifications` lo calcula y `api` solo valida y reenvía.

Límite de peticiones (`@Throttle`, por IP, sobre el general de 100/min): lecturas 60/min (el frontend sondea cada 30–60 s) y escrituras 30/min.

## API interna (`notifications`)

No se publica: el puerto 3005 no debe ser alcanzable desde fuera de la red interna (nota de despliegue). Todas las rutas exigen `X-Service-Token`; sin él o con uno distinto, 401. `GET /health` sigue sin token.

| Método y ruta | Parámetros | Respuesta |
| --- | --- | --- |
| `GET /internal/notifications` | query: `userId`, `storeId?`, `limit`, `cursor?` | `{ data: NotificationView[], nextCursor }` |
| `GET /internal/notifications/unread-count` | query: `userId`, `storeId?` | `{ count }` |
| `PATCH /internal/notifications/:id/read` | body: `{ userId, storeId? }` | `NotificationView` o 404 |
| `POST /internal/notifications/read-all` | body: `{ userId, storeId? }` | `{ updated }` |

Los DTO son `z.strictObject`: `userId` y `storeId` son ObjectId en hexadecimal; `limit` y `cursor` con las mismas reglas del contrato público.

### Filtro del actor (`policies/actor-filter.policy.ts`)

Función pura que arma el filtro de Mongo a partir de `{ userId, storeId? }`:

```ts
{ $or: [
    { destinatarioTipo: 'USER', destinatarioId: userId },
    ...(storeId ? [{ destinatarioTipo: 'STORE', destinatarioId: storeId }] : []),
] }
```

Listar, contar, `read` y `read-all` parten del mismo filtro y le suman sus condiciones (`_id`, `readAt`). Así ninguna operación puede salirse del actor.

### Guard del token de servicio (`guards/service-token.guard.ts`)

Compara `X-Service-Token` con `INTERNAL_SERVICE_TOKEN` en tiempo constante (`timingSafeEqual` sobre el SHA-256 de cada uno, para que tengan el mismo largo). Header ausente, repetido o distinto: `401` sin detalle. Se aplica con `@UseGuards` a `InternalNotificationsController`; no es global porque `GET /health` debe seguir abierto. Nunca se registra el valor del token.

## Modelo de datos

### `Notification` (cambio en `apps/notifications/src/schemas/notification.schema.ts`)

```ts
readAt?: Date; // ausente = sin leer
```

| Colección | Índices nuevos |
| --- | --- |
| `notifications` | `{ destinatarioTipo: 1, destinatarioId: 1, _id: -1 }` (listado por cursor); `{ destinatarioTipo: 1, destinatarioId: 1, readAt: 1 }` (no leídos) |

El índice `{ destinatarioTipo, destinatarioId, createdAt: -1 }` del SPEC 09 queda sin uso por esta consulta; no se elimina en este spec. El orden por `_id` descendente equivale al de creación porque cada aviso se inserta al consumir su evento.

### Marcado como leído

- `read`: `updateOne({ _id, ...filtroActor, readAt: { $exists: false } }, { $set: { readAt: ahora } })`; después se lee con `{ _id, ...filtroActor }`. Sin coincidencia en la lectura: 404.
- `read-all`: `updateMany({ ...filtroActor, readAt: { $exists: false } }, { $set: { readAt: ahora } })` y devuelve `modifiedCount`.
- Un STORE se lee y se marca por quien tiene la tienda en su token: hay un PROVEEDOR por tienda, así que el estado de lectura de un aviso `STORE` es de esa persona.

## Entorno

```ts
// envSchema (libs/common): lo heredan apiEnvSchema y notifications
INTERNAL_SERVICE_TOKEN: z.string().min(32),
// apiEnvSchema
NOTIFICATIONS_INTERNAL_URL: z.url().default('http://localhost:3005'),
```

| Variable | Obligatoria | Nota |
| --- | --- | --- |
| `INTERNAL_SERVICE_TOKEN` | Sí, en `api` y en `notifications` | Secreto compartido de mínimo 32 caracteres. Sin ella ninguna app arranca y el error nombra la variable |
| `NOTIFICATIONS_INTERNAL_URL` | No (solo `api`) | URL base interna de `notifications`. Por defecto `http://localhost:3005` |

`.env.example` incluye la primera con un valor claramente de ejemplo. Para los e2e se añade un archivo de arranque (`vitest.setup.e2e.ts`, referenciado en `vitest.config.e2e.ts`) que fija un `INTERNAL_SERVICE_TOKEN` de prueba si no existe en el entorno, ya que `ConfigModule` valida al importar el módulo.

## Módulo `notification-inbox` en `api`

Es un módulo nuevo, separado de `notification-bridge`: el puente es el camino de **escritura** (eventos → RabbitMQ) y el inbox es el de **lectura** (HTTP → `notifications`). No comparten servicios.

```text
apps/api/src/modules/notification-inbox/
  index.ts                                  # exporta NotificationInboxModule
  notification-inbox.module.ts
  controllers/notifications.controller.ts
  services/
    notification-inbox.service.ts           # arma el actor y delega
    notifications-reader.ts                 # interfaz NotificationsReader y token NOTIFICATIONS_READER
    http-notifications-reader.service.ts    # cliente `fetch` hacia notifications
  dto/notifications.dto.ts                  # schemas Zod de query y params
  policies/actor.policy.ts                  # actorFor(user)
  tests/                                    # todos los *.spec.ts, planos
```

- `policies/actor.policy.ts`: `actorFor(user)` devuelve `{ userId: user.id, storeId }` con `storeId` solo si el rol es PROVEEDOR y el token lo trae.
- `NotificationsReader` (interfaz): `list`, `unreadCount`, `markRead`, `markAllRead`, todos con el actor como primer argumento. Se inyecta con el token `NOTIFICATIONS_READER` (mismo patrón que `PAYMENT_GATEWAY` y `EVENT_PUBLISHER`), así los specs usan un lector simulado.
- `HttpNotificationsReader`: usa el `fetch` global (sin dependencias nuevas) con `AbortSignal.timeout(3000)`, el header `X-Service-Token` y `URLSearchParams` para la query; `:id` ya llegó validado como ObjectId. Valida la respuesta con un schema que **solo conserva los campos de `NotificationView`**, de modo que un campo extra de `notifications` nunca llega al cliente.
- Importa solo `modules/auth/index.js` si necesita algo de `auth`; no importa archivos internos de otros módulos. `ApiModule` lo registra con `NotificationInboxModule`.
- Orden de rutas del controller: `GET /notifications`, `GET unread-count`, `POST read-all` y `PATCH :id/read` (las fijas antes de las parametrizadas).

### Errores de la llamada a `notifications`

| Situación | Respuesta al cliente | Registro |
| --- | --- | --- |
| Timeout (3 s), conexión rechazada o red caída | `503` "Servicio de notificaciones no disponible" | `warn` con el tipo de fallo, sin URL con token ni payload |
| `401` de `notifications` (token mal configurado) | `503` | `error` ("token de servicio rechazado"), sin el valor |
| `404` de `notifications` | `404` | ninguno |
| `400` o cuerpo con otra forma de la esperada | `503` | `error` con el estado, sin cuerpo |
| `5xx` de `notifications` | `503` | `warn` con el estado |

`api` arranca sin `notifications`, `GET /health` de `api` no depende de ella y ninguna otra ruta se ve afectada. No hay reintento: el frontend ya sondea.

## `notifications`: cambios de arranque

- `main.ts`: `NestFactory.create<NestExpressApplication>`, `applySecurity(app, { corsOrigins: [] })` (helmet, sin CORS, sin `X-Powered-By`, body de 100 kb) y la etiqueta `internal` en Swagger.
- `NotificationsModule`: `APP_PIPE` con `StandardSchemaValidationPipe` (para `@Query({ schema })` y `@Body({ schema })`), `InternalNotificationsController` y `NotificationsQueryService`.
- No se añade `SecurityModule` ni throttler: el único cliente es `api` y el control es el token más la red interna.

## Estructura de archivos

```text
libs/common/src/config/env.schema.ts           # INTERNAL_SERVICE_TOKEN y NOTIFICATIONS_INTERNAL_URL
vitest.setup.e2e.ts                            # token de prueba por defecto (e2e)
vitest.config.e2e.ts                           # setupFiles
.env.example
apps/notifications/src/
  main.ts
  notifications.module.ts
  schemas/notification.schema.ts               # readAt e índices
  controllers/internal-notifications.controller.ts
  guards/service-token.guard.ts
  dto/internal-notifications.dto.ts
  policies/actor-filter.policy.ts
  services/notifications-query.service.ts      # list, unreadCount, markRead, markAllRead; mapper a NotificationView
  (specs colocados junto a cada archivo)
apps/notifications/test/internal.e2e-spec.ts
apps/api/src/modules/notification-inbox/       # ver arriba
apps/api/src/api.module.ts                     # registra NotificationInboxModule
apps/api/test/notification-inbox.e2e-spec.ts
apps/api/test/notification-flow.e2e-spec.ts    # + lectura real de los avisos del flujo
```

`apps/notifications/src` no sigue la estructura de módulo de `apps/api` (es una app aparte); aun así se crean las carpetas solo cuando tienen contenido. `notification-inbox` cumple la estructura de `CLAUDE.md`: en la raíz solo `index.ts` y `notification-inbox.module.ts`, y todos los `*.spec.ts` planos en `tests/`.

## Plan de implementación

Cada paso deja el sistema compilando y con `npm test` en verde, es commiteable por separado y no supera 30–50 líneas de código de producción (sin contar specs).

1. **Variables de entorno.** Añadir `INTERNAL_SERVICE_TOKEN` a `envSchema` y `NOTIFICATIONS_INTERNAL_URL` a `apiEnvSchema`; actualizar `.env.example`; crear `vitest.setup.e2e.ts` y referenciarlo en `vitest.config.e2e.ts`; ajustar los specs y entornos que llaman a `validateEnv` o `validateApiEnv`. Specs: falta el token, token de menos de 32 caracteres, URL inválida, URL ausente (usa el valor por defecto).
2. **Estado de lectura en el schema.** Añadir `readAt` y los dos índices a `Notification`. Spec de defaults e índices (patrón de `notification.schema.spec.ts`).
3. **Guard del token de servicio.** Crear `guards/service-token.guard.ts`. Specs: token correcto pasa; ausente, distinto, de otro largo y repetido dan 401; no registra el valor.
4. **Filtro del actor y vista pública.** Crear `policies/actor-filter.policy.ts` y el mapper `toNotificationView` (con el cálculo de `orderId`). Specs: con y sin `storeId`, `orderId` solo en `order.*` y `payment.*`, y la vista no contiene `eventId`, `eventType`, `correlationId`, `destinatarioId` ni `canal`.
5. **Listado y contador.** En `NotificationsQueryService`: `list` con cursor por `_id` descendente (`limit + 1`) y `unreadCount`. Specs con el modelo simulado: orden, `nextCursor` cuando hay más y `null` al final, el filtro incluye siempre el actor.
6. **Marcar leído.** `markRead` (idempotente, 404 si el aviso no es del actor) y `markAllRead`. Specs: marca una vez y no mueve `readAt`, ajeno da 404, `read-all` devuelve `modifiedCount`.
7. **Controller interno y arranque.** Crear los DTO estrictos y `InternalNotificationsController` con el guard; registrar `APP_PIPE`, controller y servicio en `NotificationsModule`; `applySecurity` y la etiqueta Swagger en `main.ts`. Specs del controller y de los DTO (propiedades de más, ids inválidos, `limit` fuera de rango).
8. **E2E de la API interna.** Crear `apps/notifications/test/internal.e2e-spec.ts` contra MongoDB real: sin token 401, orden y paginación por cursor, aislamiento entre actores, `unread-count`, `read` idempotente, id ajeno 404, `read-all`, y que `GET /health` sigue sin token.
9. **Cliente HTTP en `api`.** Crear `notifications-reader.ts` (interfaz y token) y `http-notifications-reader.service.ts`: header de servicio, query, timeout, validación de la respuesta y mapa de errores. Specs con `fetch` simulado: éxito, timeout, conexión rechazada, 401, 404, 5xx y cuerpo con campos de más (se descartan).
10. **Servicio y política del actor.** Crear `policies/actor.policy.ts`, `dto/notifications.dto.ts` y `NotificationInboxService`. Specs: PRODUCTOR sin `storeId`, PROVEEDOR con y sin `storeId`, el actor nunca viene de la petición.
11. **Controller y módulo públicos.** Crear `NotificationsController` con `@Roles`, `@Throttle` y Swagger; registrar el módulo en `ApiModule`. Specs: ADMIN 403, 401 sin token, rutas fijas antes de `:id`.
12. **E2E de la API pública.** Crear `apps/api/test/notification-inbox.e2e-spec.ts` con un `notifications` real en el mismo proceso: un productor no lee avisos de otro, un proveedor no lee los de otra tienda, ADMIN 403, id ajeno 404, `read` y `read-all`, `limit` fuera de rango 400. Con `NOTIFICATIONS_INTERNAL_URL` apuntando a un puerto cerrado: las rutas de avisos dan 503 y `GET /health` y `GET /catalog/...` siguen en 200.
13. **E2E del flujo.** Ampliar `notification-flow.e2e-spec.ts`: tras el pago aprobado, `GET /notifications` del productor trae `PAYMENT_APPROVED` y `ORDER_CONFIRMED_BUYER` con `orderId`, y el de cada proveedor trae su `ORDER_CONFIRMED_STORE`; `unread-count` baja a 0 tras `read-all`. Este suite abre `notifications` en un puerto libre y fija `NOTIFICATIONS_INTERNAL_URL` antes de importar `ApiModule`.
14. **Documentación.** Actualizar `docs/reglas-de-negocio.md` (los endpoints `/internal/*` pasan de "previstos" a implementados en `notifications`, reglas de lectura, `readAt` en `Notification`, que el ADMIN no ve avisos, fecha e historial) y `CLAUDE.md` (módulo `notification-inbox`, sus exports, variables nuevas en la tabla de entorno, rutas nuevas y nota de que el puerto 3005 no se publica).

## Criterios de aceptación

- [ ] `INTERNAL_SERVICE_TOKEN` ausente o de menos de 32 caracteres impide arrancar `api` y `notifications`, y el error nombra la variable. `NOTIFICATIONS_INTERNAL_URL` ausente usa `http://localhost:3005`.
- [ ] Todas las rutas `/internal/*` responden 401 sin `X-Service-Token`, con un token distinto, de otro largo o repetido; `GET /health` de `notifications` sigue respondiendo 200 sin token.
- [ ] La comparación del token es de tiempo constante y ningún log de `api` ni de `notifications` contiene su valor.
- [ ] `GET /notifications` devuelve los avisos del actor del más nuevo al más viejo, con `limit` por defecto 20 y máximo 50, y `nextCursor` correcto (`null` en la última página).
- [ ] Paginar con `cursor` no repite ni omite avisos aunque lleguen avisos nuevos entre páginas.
- [ ] Un PRODUCTOR ve solo sus avisos `USER`; un PROVEEDOR ve sus `USER` y los `STORE` de la tienda de su token; sin `storeId` en el token, solo los `USER`.
- [ ] Un usuario no puede leer, contar ni marcar avisos de otro: el `id` ajeno responde 404 y no 403.
- [ ] Un PROVEEDOR no ve los avisos `STORE` de otra tienda aunque conozca el `id`.
- [ ] El ADMIN recibe 403 en las cuatro rutas y una petición sin token, 401.
- [ ] Ninguna ruta pública acepta `userId` ni `storeId` por query, body o params: cualquier propiedad de más da 400.
- [ ] `GET /notifications/unread-count` cuenta solo los avisos visibles sin `readAt` y baja al marcar leídos.
- [ ] `PATCH /notifications/:id/read` es idempotente: repetirlo no cambia `readAt`.
- [ ] `POST /notifications/read-all` marca solo avisos del actor y la segunda llamada devuelve `updated: 0`.
- [ ] `NotificationView` no contiene `eventId`, `eventType`, `correlationId`, `destinatarioId`, `canal` ni ningún dato personal, aunque `notifications` devuelva campos de más.
- [ ] `orderId` es el `correlationId` en los avisos de pagos y pedidos y `null` en los de cuenta.
- [ ] Con `notifications` caída, lenta (más de 3 s) o con un token mal configurado, las rutas de avisos responden 503 y el resto de `api` (incluido `GET /health`) no se ve afectado; `api` arranca igual.
- [ ] Un `limit` fuera de 1–50, un `cursor` o `:id` que no sea ObjectId y propiedades desconocidas dan 400.
- [ ] Las lecturas están limitadas a 60/min y las escrituras a 30/min por IP.
- [ ] `notifications` responde con las cabeceras de `helmet`, sin `X-Powered-By`, sin CORS y con body máximo de 100 kb.
- [ ] `notification-inbox` y `notification-bridge` no se importan entre sí; `notification-inbox` cumple la estructura de módulo de `CLAUDE.md`.
- [ ] `api` no lee ninguna colección de `mini-croper-notifications`: solo habla con `notifications` por HTTP.
- [ ] Con `api` y `notifications` corriendo, un checkout de dos tiendas pagado deja los avisos visibles por `GET /notifications` del productor y de cada proveedor.
- [ ] `docs/reglas-de-negocio.md` y `CLAUDE.md` reflejan las rutas, las variables y la regla de visibilidad, y el historial tiene una entrada nueva.
- [ ] `npm run build:all`, `npm run lint`, `npm test` y `npm run test:e2e` terminan sin errores.

## Decisiones

- **Sí:** ruta pública en `api` e interna en `notifications` (opción a). Mantiene "cada app solo toca su base" y un único punto de entrada con un solo modelo de autenticación.
- **No:** `api` leyendo la base de `notifications` (opción b). Acopla `api` al esquema de otra app y rompe la frontera que se defendió desde el SPEC 09.
- **No:** `notifications` pública con JWT (opción c). Duplicaría CORS, throttler y verificación de tokens y ampliaría la superficie expuesta.
- **Sí:** el actor sale del token en `api` y viaja a `notifications` como parámetro. Ninguna ruta pública acepta `userId` ni `storeId`, así que no hay IDOR por parámetro.
- **No:** que `notifications` valide el JWT del usuario. Obligaría a compartir la clave pública y a duplicar `SecurityModule` para un único cliente confiable.
- **Sí:** filtro de propiedad dentro de la consulta de Mongo en cada operación. Un id ajeno no coincide y es indistinguible de uno inexistente.
- **Sí:** 404 y no 403 ante un aviso ajeno, y 403 solo por rol (ADMIN). No revela qué ids existen.
- **Sí:** `X-Service-Token` con comparación de tiempo constante sobre el hash. Separa la identidad de servicio del JWT de usuario y evita ataques de temporización.
- **No:** reutilizar `Authorization: Bearer` para el servicio. Se confundiría con el token de usuario en logs y herramientas.
- **Sí:** `INTERNAL_SERVICE_TOKEN` obligatoria y sin valor por defecto en las dos apps. Un valor por defecto dejaría `/internal/*` abierto si alguien olvida configurarlo.
- **Sí:** `NOTIFICATIONS_INTERNAL_URL` opcional con valor por defecto de desarrollo. No es un secreto y evita exigir otra variable a quien ya corre ambas apps en local.
- **Sí:** paginación por cursor con `_id` descendente. Es estable ante inserciones y se apoya en un índice.
- **No:** `page/limit/total` como en `order`. El `total` pide un conteo extra y las páginas se desplazan con cada aviso nuevo.
- **Sí:** `readAt` opcional en `Notification`. Es compatible con los avisos existentes (quedan sin leer) y sirve para el contador.
- **No:** guardar lecturas en una colección aparte. El aviso es de un solo destinatario, así que el estado es del propio documento.
- **Sí:** `read` idempotente que no mueve `readAt`. El frontend puede reintentar sin falsear la hora de lectura.
- **Sí:** el ADMIN recibe 403. Hoy no hay avisos para él; se decide de nuevo si algún evento lo vuelve destinatario.
- **Sí:** `NotificationView` armada campo por campo y validada otra vez en `api`. Un campo nuevo en el documento no llega al cliente por descuido (misma idea que la lista blanca del puente).
- **Sí:** `orderId` calculado por tipo de evento. El frontend enlaza al pedido sin conocer `correlationId` ni `eventType`.
- **Sí:** módulo `notification-inbox` separado de `notification-bridge`. Uno escribe por RabbitMQ y el otro lee por HTTP; no comparten ni dependencias ni fallos.
- **Sí:** lector tras el token `NOTIFICATIONS_READER`. Mismo patrón que `PAYMENT_GATEWAY` y `EVENT_PUBLISHER`; los specs no necesitan red.
- **Sí:** `fetch` global con `AbortSignal.timeout(3000)`. No añade dependencias y acota el peor caso de una caída.
- **No:** reintentos ni *circuit breaker* en este spec. El frontend ya sondea; añadir uno cuando haya evidencia de que hace falta.
- **Sí:** 503 ante cualquier fallo de `notifications`, incluido un token mal configurado. Es un problema del servidor, no del cliente, y no debe revelar la configuración.
- **Sí:** `applySecurity` y el pipe de schemas en `notifications`, sin `SecurityModule` ni throttler. Es una API interna con un solo cliente; el control es el token y la red.
- **Sí:** `docs/reglas-de-negocio.md` y `CLAUDE.md` se actualizan al implementar (paso 14), no al escribir este spec.

## Riesgos

| Riesgo | Mitigación |
| --- | --- |
| Quien obtenga `INTERNAL_SERVICE_TOKEN` puede leer y marcar avisos de cualquiera pasando un `userId` | El puerto 3005 no se publica y el token es de 32 caracteres mínimo. Aceptado en este spec; la rotación, los tokens por servicio y TLS quedan para el despliegue |
| Un despliegue que exponga el puerto 3005 deja `/internal/*` accesible desde fuera | Nota de despliegue en `CLAUDE.md` y en las reglas; el token sigue siendo obligatorio |
| `notifications` caída deja la bandeja sin datos | 503 acotado a las rutas de avisos y el frontend sigue funcionando; los avisos no se pierden porque ya están en la cola o en la base |
| Latencia extra: cada lectura es un salto HTTP más | Tiempo límite de 3 s, consultas por índice y paginación; el sondeo de 30–60 s es poco frecuente |
| El token del PROVEEDOR lleva `storeId` solo tras crear la tienda y renovar la sesión | Los avisos `STORE` llegan después de un pedido confirmado, cuando la sesión ya lo trae. Si no, solo se ven los `USER` hasta renovar el token |
| El estado de lectura de un aviso `STORE` es de una sola persona | Hay un PROVEEDOR por tienda (SPEC 06). Si cambia esa regla, `readAt` debe pasar a ser por usuario |
| El índice nuevo sobre `readAt` se crea sobre una colección con datos | La colección es pequeña y se crea con `autoIndex`; si crece, pasa a ser una migración controlada |
| Cada app valida `INTERNAL_SERVICE_TOKEN` al importar el módulo: los e2e existentes fallarían sin él | `vitest.setup.e2e.ts` fija un valor de prueba por defecto antes de importar |
| El `fetch` global depende de la versión de Node | El proyecto ya usa ESM y APIs actuales de Node; si falla en el entorno, se sustituye el cliente tras la interfaz sin tocar el resto |
| Los e2e comparten la cola real `notifications.events` | Heredado del SPEC 09: no correr otra instancia de `notifications`; los datos de prueba se borran por destinatario |

## Qué **no** está en este spec

- Push, WebSocket o SSE y cualquier canal real de envío.
- Preferencias de notificación, borrar o archivar avisos y TTL.
- Avisos al ADMIN.
- Reintentos o *circuit breaker* hacia `notifications`.
- Rotación del token de servicio, tokens por servicio y TLS.
- Reproceso de la DLQ y de eventos `FAILED` del puente.
- Plantillas editables y localización.
- Cuentas con varias tiendas o varias personas por tienda.

Cada uno de estos, si se aborda, va en su propio spec.
